import axios from 'axios'
import { env } from '@/config/env'
import { logger } from '@/lib/logger'
import { AppError, ServiceUnavailableError, AIInputRejectedError, AIServiceError } from '@/lib/errors'
import type { HealthRecord } from '@prisma/client'
import { toPersonalizationRequest } from '@/modules/predictions/personalization/evidence.builder'
import { parseGlobalAIResult, type GlobalAIResult } from '@/modules/predictions/personalization/personalization.outcome'

const aiClient = axios.create({
  baseURL: env.AI_SERVICE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Key': env.AI_SERVICE_KEY,
  },
})

// U4.2B — sex is now the canonical Paciente.sex value, supplied by the
// caller (PredictionService.predictFromHealthRecord(), which already fetches the owned
// Patient for ownership verification — no new query needed here or there).
// Encoding is already identical end-to-end (0=female/1=male, confirmed
// against ai-service/app/schemas.py and inference.py's direct
// `"male": req.sex` passthrough) — no conversion required, just the
// correct source instead of the previous hardcoded 0.
function buildFeatures(record: HealthRecord, sex: number) {
  return {
    age:           record.age,
    sex,
    currentSmoker: record.currentSmoker ? 1 : 0,
    cigsPerDay:    record.cigsPerDay,
    BPMeds:        record.bpMeds ? 1 : 0,
    diabetes:      record.diabetes ? 1 : 0,
    totChol:       Number(record.totChol),
    sysBP:         Number(record.sysBP),
    diaBP:         Number(record.diaBP),
    BMI:           Number(record.bmi),
    glucose:       Number(record.glucose),
  }
}

// NEW R (R4E) — the optional /predict `personalization` block is EXACTLY the
// validated R4B projection (version, raw_counts, units; no ids, no absolute
// timestamps, no identity). Typed from the projection itself, never a second
// hand-written copy of the wire contract.
export type AIPersonalizationRequest = ReturnType<typeof toPersonalizationRequest>

export interface AIPredictCallResult {
  // Validated GLOBAL top-level result (R4D: top-level is ALWAYS global).
  global: GlobalAIResult
  // Raw, still-unvalidated `personalization` value (undefined if absent).
  // Validated by personalization.outcome.ts — never trusted as-is.
  personalizationRaw: unknown
}

// ONE HTTP call. With `personalization` the AI returns the global top-level
// result AND the personalization block from the same request (R3/R4D);
// without it, the legacy global-only contract.
export async function callAIPredict(
  record: HealthRecord,
  sex: number,
  personalization?: AIPersonalizationRequest,
): Promise<AIPredictCallResult> {
  let data: unknown
  try {
    const payload = personalization ? { ...buildFeatures(record, sex), personalization } : buildFeatures(record, sex)
    // R4E — safe metadata only: never the clinical payload or the history.
    logger.debug('Calling AI service', {
      personalization: Boolean(personalization),
      units: personalization ? personalization.units.length : 0,
    })
    const res = await aiClient.post<unknown>('/predict', payload)
    data = res.data
  } catch (err) {
    const mapped = mapAIError(err)
    logger.error('AI service error', { ...describeAIError(err), mappedCode: mapped.code })
    // Q2-FIX: no mock/heuristic fallback of any kind, in any environment.
    // CardioSense has a real inference service (Skorp-Beta-0.2) — an
    // unreachable/failing AI Service is a genuine inference failure, not a
    // condition to silently paper over with a fabricated risk score. The
    // previous dev-mode fallback here is exactly what caused a mock
    // prediction (model_version: '1.2.0-mock') to be persisted and treated
    // as real when the AI Service was stopped.
    // U8.6B — no longer every failure → 503: a reachable AI that rejects the
    // payload (422) is not "unavailable". Still never a fallback prediction.
    throw mapped
  }
  // R4E — the mandatory GLOBAL result must be valid; otherwise this is an AI
  // failure (no Prediction, no Alert), never a personalization fallback.
  const global = parseGlobalAIResult(data)
  if (!global) {
    logger.error('AI service returned an invalid global result', { mappedCode: 'AI_FAILURE' })
    throw new AIServiceError()
  }
  const personalizationRaw = typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>).personalization
    : undefined
  return { global, personalizationRaw }
}

// U8.6B — model capability contract, owned by the model artifact
// (metadata.json → AI GET /health). The backend never hardcodes the range.
export interface ModelCapabilities {
  modelVersion: string
  eligibleAgeRange: { min: number; max: number }
}

function isAgeRange(v: unknown): v is { min: number; max: number } {
  if (typeof v !== 'object' || v === null) return false
  const { min, max } = v as { min?: unknown; max?: unknown }
  return Number.isInteger(min) && Number.isInteger(max) && (min as number) <= (max as number)
}

// Fails CLOSED: if the capability cannot be determined, that is technical
// unavailability (503) — never an assumed range, never "ineligible".
export async function getModelCapabilities(): Promise<ModelCapabilities> {
  let body: { model_loaded?: unknown; model_version?: unknown; eligible_age_range?: unknown }
  try {
    const res = await aiClient.get('/health')
    body = res.data ?? {}
  } catch (err) {
    logger.error('AI capability lookup failed', describeAIError(err))
    throw new ServiceUnavailableError('AI model capability')
  }
  if (body.model_loaded !== true || typeof body.model_version !== 'string' || !isAgeRange(body.eligible_age_range)) {
    logger.error('AI capability contract unavailable', { model_loaded: body.model_loaded })
    throw new ServiceUnavailableError('AI model capability')
  }
  return { modelVersion: body.model_version, eligibleAgeRange: body.eligible_age_range }
}

export function isAgeEligible(age: number, capabilities: ModelCapabilities): boolean {
  return age >= capabilities.eligibleAgeRange.min && age <= capabilities.eligibleAgeRange.max
}

// AI 422 → input rejected; 503 or no response (timeout/network) → unavailable;
// any other response → AI failure. Raw AI bodies are never forwarded.
export function mapAIError(err: unknown): AppError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    if (status === undefined) return new ServiceUnavailableError('AI prediction')
    if (status === 422) return new AIInputRejectedError()
    if (status === 503) return new ServiceUnavailableError('AI prediction')
    return new AIServiceError()
  }
  return new AIServiceError()
}

// Safe log fields only — the axios error object carries request headers,
// including X-Internal-Key, and must not be logged whole.
function describeAIError(err: unknown): Record<string, unknown> {
  if (axios.isAxiosError(err)) {
    return { status: err.response?.status, code: err.code, message: err.message }
  }
  return { message: err instanceof Error ? err.message : String(err) }
}
