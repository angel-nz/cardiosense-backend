// NEW R (R4E) — PURE normalization of one AI /predict result into the
// persisted NEW-R outcome (no I/O, no Prisma client, no clock).
//
//   AI top-level fields         = the GLOBAL result (R4D contract)
//   AI `personalization` block  = R4C/R4D outcome (status, final score/level,
//                                 non-clinical diagnostics)
//   R4B evidence                = backend provenance (cutoff, counts,
//                                 fingerprint) — the source ids it holds are
//                                 NEVER copied into the outcome
//
// Every successfully created Prediction after R4E is a NEW-R row: this module
// always returns a status, a final score/level and a provenance document,
// including for every fallback. It never fabricates a global result — the
// caller only reaches it with an already-validated GLOBAL result.
import type { PersonalizationStatus, RiskLevel } from '@prisma/client'
import { scoreToBasisPoints, type EvidenceCounts, type PersonalizationEvidence } from './evidence.builder'
import {
  PERSONALIZATION_VERSION, PERSONALIZATION_STATUSES, PERSONALIZATION_PROVENANCE_SCHEMA,
  BACKEND_PERSONALIZATION_REASON,
} from './personalization.constants'

// Compile-time proof that the backend status list IS the Prisma enum (both
// directions): a missing, extra or renamed literal fails `tsc`.
type StatusList = typeof PERSONALIZATION_STATUSES[number]
type _SameStatuses = [StatusList] extends [PersonalizationStatus]
  ? ([PersonalizationStatus] extends [StatusList] ? true : never) : never
const _statusesMatchPrisma: _SameStatuses = true
void _statusesMatchPrisma

export type AIRiskLevel = 'low' | 'moderate' | 'high'
const AI_RISK_LEVELS: readonly AIRiskLevel[] = ['low', 'moderate', 'high']
const RISK_LEVEL_TO_PRISMA: Record<AIRiskLevel, RiskLevel> = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH' }
export const toPrismaRiskLevel = (l: AIRiskLevel): RiskLevel => RISK_LEVEL_TO_PRISMA[l]

const CONDITIONED_FEATURES = ['sysBP', 'diaBP', 'totChol', 'glucose'] as const
type ConditionedFeature = typeof CONDITIONED_FEATURES[number]

// ─── Validated GLOBAL result (parsed in aiClient; failure ⇒ AI failure) ────
export interface GlobalAIResult {
  riskScore:         number          // AI top-level risk_score (4 dp)
  riskScoreBp:       number          // exact basis points of riskScore
  riskLevel:         AIRiskLevel
  anomalyScore:      number
  isAnomaly:         boolean
  featureImportance: Record<string, number>
  modelVersion:      string
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isLevel = (v: unknown): v is AIRiskLevel => typeof v === 'string' && (AI_RISK_LEVELS as readonly string[]).includes(v)
const isStatus = (v: unknown): v is PersonalizationStatus =>
  typeof v === 'string' && (PERSONALIZATION_STATUSES as readonly string[]).includes(v)
// AI reasons are stored unchanged, but only if they look like a stable
// machine code (never free text / prose / arbitrary length).
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

// A probability exactly as serialized by the AI (≤ 4 decimals, in [0,1]).
function probabilityBp(v: unknown): number | null {
  if (!isFiniteNum(v) || v < 0 || v > 1) return null
  return scoreToBasisPoints(v)
}

export function parseGlobalAIResult(raw: unknown): GlobalAIResult | null {
  if (!isObj(raw)) return null
  const bp = probabilityBp(raw.risk_score)
  if (bp === null || !isLevel(raw.risk_level)) return null
  if (!isFiniteNum(raw.anomaly_score) || typeof raw.is_anomaly !== 'boolean') return null
  if (typeof raw.model_version !== 'string' || raw.model_version.trim() === '') return null
  const fi = raw.feature_importance
  if (!isObj(fi) || !Object.values(fi).every(isFiniteNum)) return null
  return {
    riskScore: raw.risk_score as number, riskScoreBp: bp, riskLevel: raw.risk_level,
    anomalyScore: raw.anomaly_score, isAnomaly: raw.is_anomaly,
    featureImportance: fi as Record<string, number>, modelVersion: raw.model_version,
  }
}

// ─── Validated AI personalization block (R4D) ──────────────────────────────
export type FeatureDiagnostics = { s: number; KAnchor: number; KAnchorPrime: number }

export interface AIPersonalizationBlock {
  status:                 PersonalizationStatus
  reason:                 string | null
  finalRiskScore:         number
  finalRiskLevel:         AIRiskLevel
  Q:                      number | null
  gamma:                  number | null
  deltaLogit:             number | null
  rawAdjustment:          number | null
  appliedLogit:           number | null
  bounded:                boolean | null
  bpReverted:             boolean | null
  sigmaExp:               number | null
  effectiveClinicalUnits: number | null
  piUnits:                number | null
  comparableTransitions:  number | null
  excludedTransitions:    Record<string, number> | null
  perFeature:             Record<ConditionedFeature, FeatureDiagnostics> | null
}

const nullableNum = (v: unknown): v is number | null => v === null || isFiniteNum(v)
const nullableBool = (v: unknown): v is boolean | null => v === null || typeof v === 'boolean'
const nullableCount = (v: unknown): v is number | null => v === null || isNonNegInt(v)

/** Returns null for ANY contract violation (caller → AI_PERSONALIZATION_RESPONSE_INVALID). */
export function parsePersonalizationBlock(raw: unknown, global: GlobalAIResult): AIPersonalizationBlock | null {
  if (!isObj(raw)) return null
  if (raw.version !== PERSONALIZATION_VERSION || !isStatus(raw.status)) return null
  const individualized = raw.status === 'INDIVIDUALIZED'
  if (individualized ? raw.reason !== null : (typeof raw.reason !== 'string' || !REASON_PATTERN.test(raw.reason))) return null

  const finalBp = probabilityBp(raw.final_risk_score)
  if (finalBp === null || !isLevel(raw.final_risk_level)) return null
  // Fallback ⇒ final IS global, at API precision (exact basis points) and level.
  if (!individualized && (finalBp !== global.riskScoreBp || raw.final_risk_level !== global.riskLevel)) return null

  const nums = ['Q', 'gamma', 'delta_logit', 'raw_adjustment', 'applied_logit', 'sigma_exp'] as const
  for (const k of nums) {
    if (!nullableNum(raw[k])) return null
    if (individualized && raw[k] === null) return null
  }
  for (const k of ['bounded', 'bp_reverted'] as const) {
    if (!nullableBool(raw[k])) return null
    if (individualized && raw[k] === null) return null
  }
  for (const k of ['effective_clinical_units', 'pi_units', 'comparable_transitions'] as const) {
    if (!nullableCount(raw[k])) return null
    if (individualized && raw[k] === null) return null
  }
  if (raw.gamma !== null && ((raw.gamma as number) < 0 || (raw.gamma as number) > 1)) return null

  let excluded: Record<string, number> | null = null
  if (raw.excluded_transitions !== null) {
    const et = raw.excluded_transitions
    if (!isObj(et)) return null
    excluded = {}
    for (const [k, v] of Object.entries(et)) {
      if (!REASON_PATTERN.test(k) || !isNonNegInt(v)) return null
      excluded[k] = v
    }
  } else if (individualized) return null

  let perFeature: Record<ConditionedFeature, FeatureDiagnostics> | null = null
  if (raw.per_feature !== null && raw.per_feature !== undefined) {
    const pf = raw.per_feature
    if (!isObj(pf) || Object.keys(pf).length !== CONDITIONED_FEATURES.length) return null
    const out = {} as Record<ConditionedFeature, FeatureDiagnostics>
    for (const f of CONDITIONED_FEATURES) {
      const d = pf[f]
      if (!isObj(d) || !isFiniteNum(d.s) || !isFiniteNum(d.K_anchor) || !isFiniteNum(d.K_anchor_prime)) return null
      // Only the gain / change-guard diagnostics are retained (R3 provenance).
      out[f] = { s: d.s, KAnchor: d.K_anchor, KAnchorPrime: d.K_anchor_prime }
    }
    perFeature = out
  } else if (individualized) return null

  return {
    status: raw.status, reason: individualized ? null : (raw.reason as string),
    finalRiskScore: raw.final_risk_score as number, finalRiskLevel: raw.final_risk_level,
    Q: raw.Q as number | null, gamma: raw.gamma as number | null,
    deltaLogit: raw.delta_logit as number | null, rawAdjustment: raw.raw_adjustment as number | null,
    appliedLogit: raw.applied_logit as number | null,
    bounded: raw.bounded as boolean | null, bpReverted: raw.bp_reverted as boolean | null,
    sigmaExp: raw.sigma_exp as number | null,
    effectiveClinicalUnits: raw.effective_clinical_units as number | null,
    piUnits: raw.pi_units as number | null,
    comparableTransitions: raw.comparable_transitions as number | null,
    excludedTransitions: excluded, perFeature,
  }
}

// ─── Provenance (audit JSON persisted in Prediction.personalizationProvenance)
// Contains NO raw clinical values, NO x̃, NO π sequence, NO record /
// prediction ids, NO names / contact data / notes. `null` always means "not
// evaluated / not available" — never a fabricated zero.
// R4B counts as a JSON-compatible type literal (same keys, numbers only).
export type ProvenanceCounts = {
  clinical:   { [K in keyof EvidenceCounts['clinical']]: number }
  prediction: { [K in keyof EvidenceCounts['prediction']]: number }
}

export type PersonalizationProvenance = {
  schema:                 typeof PERSONALIZATION_PROVENANCE_SCHEMA
  personalizationVersion: typeof PERSONALIZATION_VERSION
  status:                 PersonalizationStatus
  reason:                 string | null
  reasonOrigin:           'AI' | 'BACKEND' | null
  globalModelVersion:     string                 // AI top-level model_version of THIS prediction
  evidence: {
    cutoff:              string                  // anchor recordedAt (ISO-8601 UTC); causal cutoff
    policyModelVersion:  string | null           // global model version R4B selected π with
    evidenceFingerprint: string | null           // exact R4B SHA-256 (null if extraction failed)
    counts:              ProvenanceCounts | null // R4B counts by stable reason (null if extraction failed)
  }
  ai: {
    effectiveClinicalUnits: number | null
    piUnits:                number | null
    comparableTransitions:  number | null
    excludedTransitions:    Record<string, number> | null
    Q:                      number | null
    gamma:                  number | null
    deltaLogit:             number | null
    rawAdjustment:          number | null
    appliedLogit:           number | null
    bounded:                boolean | null
    bpReverted:             boolean | null
    sigmaExp:               number | null
    perFeature:             Record<ConditionedFeature, FeatureDiagnostics> | null
  } | null                                       // null ⇒ no valid AI personalization diagnostics
}

export interface PersonalizationOutcome {
  status:         PersonalizationStatus
  reason:         string | null
  finalRiskScore: number
  finalRiskLevel: AIRiskLevel
  provenance:     PersonalizationProvenance
  // NEW S2C — additive, read-only carry of the TYPED decisive `applied_logit`
  // of THIS REAL R execution (the validated AI block value), for the S
  // forecast bridge capture only. INDIVIDUALIZED → that number; every other
  // status → null. Never read back from provenance; changes no R value.
  bridgeAppliedLogit: number | null
}

export interface ResolveOutcomeInput {
  global:            GlobalAIResult
  anchorRecordedAt:  Date
  // R4B result, or null when extraction failed (then NO block was sent).
  evidence:          PersonalizationEvidence | null
  // The raw AI `personalization` value (undefined when the key was absent).
  personalizationRaw: unknown
}

export function resolvePersonalizationOutcome(input: ResolveOutcomeInput): PersonalizationOutcome {
  const { global, evidence } = input
  const evidenceProv: PersonalizationProvenance['evidence'] = {
    cutoff:              input.anchorRecordedAt.toISOString(),
    policyModelVersion:  evidence ? evidence.globalModelVersion : null,
    evidenceFingerprint: evidence ? evidence.evidenceFingerprint : null,
    counts:              evidence ? cloneCounts(evidence.counts) : null,
  }
  const globalFallback = (reason: string): PersonalizationOutcome => ({
    status: 'GLOBAL_ERROR_FALLBACK', reason,
    finalRiskScore: global.riskScore, finalRiskLevel: global.riskLevel,
    bridgeAppliedLogit: null,
    provenance: {
      schema: PERSONALIZATION_PROVENANCE_SCHEMA, personalizationVersion: PERSONALIZATION_VERSION,
      status: 'GLOBAL_ERROR_FALLBACK', reason, reasonOrigin: 'BACKEND',
      globalModelVersion: global.modelVersion, evidence: evidenceProv, ai: null,
    },
  })

  if (!evidence) return globalFallback(BACKEND_PERSONALIZATION_REASON.EVIDENCE_EXTRACTION_FAILED)

  const block = parsePersonalizationBlock(input.personalizationRaw, global)
  // π was selected for R4B's global model version; a different serving
  // model would make the γ channel compare scores of two models.
  if (!block || evidence.globalModelVersion !== global.modelVersion) {
    return globalFallback(BACKEND_PERSONALIZATION_REASON.AI_PERSONALIZATION_RESPONSE_INVALID)
  }

  const individualized = block.status === 'INDIVIDUALIZED'
  return {
    status: block.status,
    reason: block.reason,
    // Fallback statuses persist the AI's own (validated-equal) global values.
    finalRiskScore: individualized ? block.finalRiskScore : global.riskScore,
    finalRiskLevel: individualized ? block.finalRiskLevel : global.riskLevel,
    bridgeAppliedLogit: individualized ? block.appliedLogit : null,
    provenance: {
      schema: PERSONALIZATION_PROVENANCE_SCHEMA, personalizationVersion: PERSONALIZATION_VERSION,
      status: block.status, reason: block.reason, reasonOrigin: individualized ? null : 'AI',
      globalModelVersion: global.modelVersion, evidence: evidenceProv,
      ai: {
        effectiveClinicalUnits: block.effectiveClinicalUnits, piUnits: block.piUnits,
        comparableTransitions: block.comparableTransitions, excludedTransitions: block.excludedTransitions,
        Q: block.Q, gamma: block.gamma, deltaLogit: block.deltaLogit, rawAdjustment: block.rawAdjustment,
        appliedLogit: block.appliedLogit, bounded: block.bounded, bpReverted: block.bpReverted,
        sigmaExp: block.sigmaExp, perFeature: block.perFeature,
      },
    },
  }
}

function cloneCounts(c: EvidenceCounts): ProvenanceCounts {
  return { clinical: { ...c.clinical }, prediction: { ...c.prediction } }
}
