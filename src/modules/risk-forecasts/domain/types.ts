// NEW S2B — pure input / output types of the S forecast-planning engine.
//
// Plain domain types (no Prisma model instances required): the engine can be
// unit-tested deterministically and later fed by thin adapters. The input
// deliberately has NO place for Prediction history, risk scores, forecast
// history or personalization provenance — S never extrapolates risk.

import type { SPolicyVersions } from './constants'

// ─── Inputs ──────────────────────────────────────────────────────────────
// Any exact decimal representation: number, decimal string, or a
// Prisma.Decimal (anything whose toString() is a decimal literal).
export type DecimalLike = number | string | { toString(): string }

export type SClinicalTimeSource = 'CLINICIAN_ENTERED' | 'LEGACY_ENTRY_TIME'

export interface SPatientInput {
  patientId: string
  birthDate: string        // pure calendar date YYYY-MM-DD
  sex:       number        // 0 | 1 expected; anything else makes records invalid
  isActive:  boolean
  isHidden:  boolean
}

export interface SRealRecordInput {
  id:                 string
  recordedAt:         Date                 // entry instant (R's axis; S tie-break / legacy fallback)
  measuredAt:         Date | null          // REAL clinical instant (CLINICIAN_ENTERED only)
  clinicalTimeSource: SClinicalTimeSource
  age:                number               // persisted age of the record
  currentSmoker:      boolean
  cigsPerDay:         number
  bpMeds:             boolean
  diabetes:           boolean
  totChol:            DecimalLike
  sysBP:              DecimalLike
  diaBP:              DecimalLike
  bmi:                DecimalLike
  heartRate:          number
  glucose:            DecimalLike
}

export interface SModelContractInput {
  modelVersion:     string
  eligibleAgeRange: { min: number; max: number }   // current Skorp metadata (AI /health)
}

// Typed identity of a FUTURE Alternative-B bridge state — fingerprint input
// only. No numeric state, no provenance JSON; S2B never uses it otherwise.
export interface SBridgeIdentity {
  bridgeStateId:          string
  bridgeVersion:          string
  personalizationVersion: string
  modelVersion:           string
}

export interface SPlanInput {
  patient:        SPatientInput
  records:        readonly SRealRecordInput[]   // ALL REAL HealthRecords of the patient, any order
  model:          SModelContractInput
  bridgeIdentity?: SBridgeIdentity | null
}

// ─── Outputs ─────────────────────────────────────────────────────────────
export type SLifecycleResult =
  | 'ACTIVE'
  | 'PATIENT_INACTIVE'           // INACTIVE_VISIBLE
  | 'PATIENT_HIDDEN'             // isActive=false, isHidden=true
  | 'PATIENT_LIFECYCLE_INVALID'  // isActive=true, isHidden=true

// Same literals as Prisma ForecastEligibilityStatus (S2A).
export type SEligibilityStatus =
  | 'HISTORY_ABSENT'
  | 'HISTORY_INVALID'
  | 'CLINICAL_HISTORY_INSUFFICIENT'
  | 'FREQUENCY_UNRELIABLE'
  | 'FORECAST_ELIGIBLE'

export type SEligibilityReason =
  | 'NO_HEALTH_RECORDS'
  | 'NO_USABLE_RECORD'
  | 'LATEST_RECORD_INVALID'
  | 'LATEST_RECORD_OUT_OF_MODEL_DOMAIN'
  | 'NO_MEASURED_CLINICAL_TIME'
  | 'ANCHOR_CLINICAL_TIME_NOT_MEASURED'
  | 'MEASURED_VISITS_BELOW_MINIMUM'
  | SCadenceAbstainReason
  | SCadenceMethod

// NEW S3/S4 — cadence methods (S-CAD-1's RECENT_REGIME / WINDOW_INLIER_MEDIAN
// remain only on historical persisted S-1 sets). MULTIMODAL_TRANSITION is
// S-CAD-3 only.
export type SCadenceMethod = 'ROBUST_MEDIAN' | 'ROBUST_MEDIAN_WITH_MISSED_VISITS' | 'MULTIMODAL_TRANSITION'
// MULTIMODAL_CADENCE: S-CAD-2 only (historical). MULTIMODAL_UNRELIABLE /
// MODE_OUT_OF_BOUNDS: S-CAD-3.
export type SCadenceAbstainReason = 'TOO_FEW_GAPS' | 'NO_DOMINANT_CADENCE' | 'MULTIMODAL_CADENCE' | 'DELTA_OUT_OF_BOUNDS' | 'MULTIMODAL_UNRELIABLE' | 'MODE_OUT_OF_BOUNDS'

// NEW S4 — S-CAD-3 two-mode trace (deterministic; transition COUNTS are not
// probabilities or confidence).
export interface SCadenceModes {
  modes:       Array<{ label: 'L' | 'H'; members: number[]; valueRaw: number; valueDays: number }>
  labels:      Array<'L' | 'H'>                    // chronological labels of the window gaps
  transitions: { LL: number; LH: number; HL: number; HH: number }
  latestMode:  'L' | 'H'
  sequence:    Array<'L' | 'H'>                    // the 3 projected modes
}

// Deterministic S-CAD-2 trace (diagnostic only; persisted with the set's
// eligibility JSON, never exposed as a clinical claim).
export interface SCadenceDiagnostics {
  window:    number[]                                  // newest ≤ 8 gaps (chronological)
  split:     { ratioNum: number; ratioDen: number; lower: number; upper: number; multimodal: boolean }
  medianAll: number | null                             // median of the window (step 2)
  classes:   Array<'DIRECT' | 'POSSIBLE_MISSED_VISIT' | 'UNEXPLAINED'> | null
}

// deltaRaw / deltaDays: the single unimodal cadence (null for multimodal).
// intervalsDays (NEW S4, S-CAD-3): the exact 3 horizon intervals — unimodal
// [d,d,d]; multimodal e.g. [7,21,7]. Target dates are CUMULATIVE.
export type SCadenceResult =
  | { status: 'OK'; deltaRaw: number | null; deltaDays: number | null; intervalsDays: [number, number, number]; method: SCadenceMethod; diagnostics: SCadenceDiagnostics; multimodal: SCadenceModes | null }
  | { status: 'ABSTAIN'; reason: SCadenceAbstainReason; diagnostics: SCadenceDiagnostics | null }

// Planning-level subset of Prisma ForecastGenerationStatus. S2B never
// produces FAILED (technical / AI failures belong to orchestration).
export type SPlanGenerationStatus = 'NOT_APPLICABLE' | 'GENERATED_FULL' | 'GENERATED_PARTIAL' | 'NONE_ADMISSIBLE'

export type SRecordStatus = 'USABLE' | 'INVALID' | 'OUT_OF_MODEL_DOMAIN'

export interface SCounts {
  totalRealRecordCount:              number
  usableRecordCount:                 number
  invalidRecordCount:                number
  outOfModelDomainCount:             number
  legacyRecordCount:                 number
  clinicianEnteredRecordCount:       number
  clinicianEnteredUsableRecordCount: number
  measuredVisitCount:                number
  positiveGapCount:                  number
}

export interface SAnchor {
  healthRecordId:     string
  clinicalTimeSource: SClinicalTimeSource
  knowledgeCutoff:    string   // ISO-8601 ms instant (anchor measuredAt)
  cutoffLocalDay:     string   // YYYY-MM-DD, Guadalajara
}

// The 12 model inputs in the AI PredictRequest naming (same shape as
// lib/aiInput.ts AIPredictionInput): booleans as 0|1, JSON numbers.
export interface SSimulatedState {
  age:           number
  sex:           number
  currentSmoker: 0 | 1
  cigsPerDay:    number
  BPMeds:        0 | 1
  diabetes:      0 | 1
  totChol:       number
  sysBP:         number
  diaBP:         number
  BMI:           number
  heartRate:     number
  glucose:       number
}

// NEW S3 — 'LOCF' (S-FEAT-LOCF-1) is superseded: continuous indicators are
// ROBUST_TREND (non-zero effective slope) or ROBUST_TREND_FLAT (estimated
// flat trend — the value may equal the anchor but is NOT a carried value).
// NEW S4 — SEQUENTIAL_ROBUST_TREND / _FLAT (S-FEAT-SEQUENTIAL-ROBUST-1). The
// ROBUST_TREND* values remain only on historical S-2 rows.
export type SFeatureProvenance = 'DERIVED' | 'CARRY_FORWARD' | 'CONDITIONAL' | 'ROBUST_TREND' | 'ROBUST_TREND_FLAT' | 'SEQUENTIAL_ROBUST_TREND' | 'SEQUENTIAL_ROBUST_FLAT'

// Per-feature robust trend summary (deterministic; set-level audit JSON only).
export interface SFeatureTrend {
  observations:     number      // measured visits used
  pairCount:        number      // pairwise slopes
  rawSlope:         number      // Theil–Sen median slope, units/day
  positivePairs:    number
  negativePairs:    number
  trendConsistency: number      // |P − N| / (P + N), 0 when P + N = 0 — NOT a confidence
  effectiveSlope:   number      // rawSlope × trendConsistency
}

// NEW S4 — weighted (S-FEAT-SEQUENTIAL-ROBUST-1) per-feature trend.
export interface SWeightedFeatureTrend {
  pairCount:        number      // pairs with distinct effective instants
  rawSlope:         number      // weighted median of pairwise slopes, units/day
  positiveWeight:   number      // W+ (unscaled weights)
  negativeWeight:   number      // W−
  trendConsistency: number      // |W+ − W−| / (W+ + W−), 0 when both are 0 — NOT a confidence
  effectiveSlope:   number      // rawSlope × trendConsistency
}

// NEW S4 — per-horizon context provenance (persisted as sequential_context).
export interface SSequentialContext {
  horizonIndex:      1 | 2 | 3
  realRecordCount:   number
  realRecordIds:     string[]                  // internal audit (never exposed by the public API)
  latestRealRecordId: string
  simulatedContext:  Array<'F1' | 'F2'>        // in-run earlier horizons only
  weights:           { ordinaryReal: number; latestReal: number; simulated: number }
  features:          Record<string, SWeightedFeatureTrend>
}

export interface SAssumptionFlags {
  cigsForcedZero:       boolean
  ageChangedFromAnchor: boolean
}

export interface SPlannedTarget {
  horizonIndex:      1 | 2 | 3
  targetDate:        string   // YYYY-MM-DD (a DATE, not an appointment time)
  targetAge:         number
  simulatedState:    SSimulatedState
  featureProvenance: Readonly<Record<keyof SSimulatedState, SFeatureProvenance>>
  assumptionFlags:   SAssumptionFlags
  sequentialContext?: SSequentialContext       // NEW S4 (absent only on the historical S-2 direct path)
}

export interface SCadenceEvidence {
  visitDays: string[]   // local clinical days, ascending (measured visits only)
  gaps:      number[]   // positive integer day gaps
}

export interface SEvaluatedPlan {
  kind:            'EVALUATED'
  lifecycle:       'ACTIVE'
  eligibility:     { status: SEligibilityStatus; reason: SEligibilityReason }
  counts:          SCounts
  anchor:          SAnchor | null                 // only when FORECAST_ELIGIBLE
  cadenceEvidence: SCadenceEvidence | null        // when measured visits were built
  cadence:         SCadenceResult | null          // when S-CAD-2 ran
  featureTrends:   Record<string, SWeightedFeatureTrend> | null   // NEW S4 — F1 (REAL-only) context trends, when eligible
  generation:      { status: SPlanGenerationStatus; reason: string | null }
  targets:         SPlannedTarget[]
  policies:        SPolicyVersions
  model:           SModelContractInput
  inputFingerprint: string
}

export interface SLifecycleGatedPlan {
  kind:             'LIFECYCLE_GATED'
  lifecycle:        Exclude<SLifecycleResult, 'ACTIVE'>
  policies:         SPolicyVersions
  model:            SModelContractInput
  inputFingerprint: string
}

export type SPlanResult = SEvaluatedPlan | SLifecycleGatedPlan

// Raised for inputs that violate the S2A data contract (e.g. a
// CLINICIAN_ENTERED record without measuredAt). Fail closed — never repaired.
export class SInputContractError extends Error {
  constructor(message: string) { super(message); this.name = 'SInputContractError' }
}
