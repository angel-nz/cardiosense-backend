// NEW S2C — backend client for AI POST /forecast/score.
//
// Accepts ONLY: the expected model version, 1–3 simulated 11-feature target
// states (rebuilt field-by-field, so nothing else can leak), and optionally a
// COMPATIBLE typed appliedLogit. No patient/record ids, no Predictions, no
// provenance, no RiskForecast rows. No mock / synthetic fallback: any AI or
// contract failure is thrown (later orchestration maps it to FAILED).
import axios from 'axios'
import { env } from '@/config/env'
import { logger } from '@/lib/logger'
import { AppError, AIServiceError } from '@/lib/errors'
import { mapAIError } from '@/lib/aiClient'
import type { SSimulatedState } from '../domain/types'

const forecastAI = axios.create({
  baseURL: env.AI_SERVICE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.AI_SERVICE_KEY },
})

export class ForecastModelVersionMismatchError extends AppError {
  constructor() { super('AI forecast model version mismatch', 409, 'AI_FORECAST_MODEL_MISMATCH') }
}

export type ForecastInterpretation = 'GLOBAL' | 'INDIVIDUALIZED_BRIDGE'
export interface ForecastScore {
  targetIndex:     number
  globalRiskScore: number
  finalRiskScore:  number
  riskLevel:       'LOW' | 'MODERATE' | 'HIGH'
  interpretation:  ForecastInterpretation
}

const FIELDS: (keyof SSimulatedState)[] = ['age', 'sex', 'currentSmoker', 'cigsPerDay', 'BPMeds', 'diabetes', 'totChol', 'sysBP', 'diaBP', 'BMI', 'glucose']
const pick = (s: SSimulatedState) => Object.fromEntries(FIELDS.map(f => [f, s[f]])) as unknown as SSimulatedState

const isScore = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 && Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-6

export function validateForecastResponse(data: unknown, expectedModelVersion: string, n: number, adjusted: boolean): ForecastScore[] | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { model_version?: unknown; scores?: unknown }
  if (d.model_version !== expectedModelVersion || !Array.isArray(d.scores) || d.scores.length !== n) return null
  const want: ForecastInterpretation = adjusted ? 'INDIVIDUALIZED_BRIDGE' : 'GLOBAL'
  const out: ForecastScore[] = []
  for (let i = 0; i < n; i++) {
    const s = d.scores[i] as Record<string, unknown>
    if (typeof s !== 'object' || s === null || s.targetIndex !== i) return null
    if (!isScore(s.globalRiskScore) || !isScore(s.finalRiskScore)) return null
    if (s.riskLevel !== 'LOW' && s.riskLevel !== 'MODERATE' && s.riskLevel !== 'HIGH') return null
    if (s.interpretation !== want) return null
    if (!adjusted && s.finalRiskScore !== s.globalRiskScore) return null
    out.push({ targetIndex: i, globalRiskScore: s.globalRiskScore, finalRiskScore: s.finalRiskScore, riskLevel: s.riskLevel, interpretation: want })
  }
  return out
}

export async function scoreForecastTargets(args: {
  expectedModelVersion: string
  targets:              readonly SSimulatedState[]
  appliedLogit?:        number | null
}): Promise<ForecastScore[]> {
  const n = args.targets.length
  if (n < 1 || n > 3) throw new RangeError('forecast scoring needs 1–3 targets')
  const adjusted = args.appliedLogit !== undefined && args.appliedLogit !== null
  if (adjusted && !Number.isFinite(args.appliedLogit)) throw new RangeError('non-finite appliedLogit')
  const body = {
    expected_model_version: args.expectedModelVersion,
    targets: args.targets.map(pick),
    individualized_adjustment: adjusted ? { applied_logit: args.appliedLogit } : null,
  }
  let data: unknown
  try {
    logger.debug('Calling AI forecast scoring', { targets: n, adjusted })   // aggregate metadata only
    data = (await forecastAI.post<unknown>('/forecast/score', body)).data
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 409) throw new ForecastModelVersionMismatchError()
    const mapped = mapAIError(err)
    logger.error('AI forecast scoring error', { status: axios.isAxiosError(err) ? err.response?.status : undefined, mappedCode: mapped.code })
    throw mapped
  }
  const scores = validateForecastResponse(data, args.expectedModelVersion, n, adjusted)
  if (!scores) {
    logger.error('AI forecast scoring returned an invalid response', { mappedCode: 'AI_FAILURE' })
    throw new AIServiceError()
  }
  return scores
}
