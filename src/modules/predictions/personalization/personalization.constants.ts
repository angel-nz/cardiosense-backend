// PRE-T-R1 — single canonical home of the backend-owned evidence-policy
// constants for Phase R.
//
// Contract: personalizationVersion "R-BPBC-3". PRE-T-R1 changes ONLY the
// clinical causal clock from recordedAt to measuredAt. BPBC mathematics,
// gamma, reliability Q, logit bound, conditioned features and fallback
// statuses remain unchanged from R-BPBC-2.

export const PERSONALIZATION_VERSION = 'R-BPBC-3' as const

// Δ_min — ENGINEERING anti-duplicate / information-cap window. Under
// R-BPBC-3 this window is evaluated on measuredAt, the clinical clock.
// Anchored-start, half-open: a burst started at s contains records with
// measuredAt < s + Δ_min. recordedAt is never a causal fallback.
export const EVIDENCE_BURST_WINDOW_MS = 60 * 60 * 1000

// Same Δ_min, applied to the anchor-duplicate rule: a prior record with
// anchor.measuredAt − record.measuredAt < this window and an identical
// clinical state to the anchor is DUPLICATE_OF_ANCHOR.
export const ANCHOR_DUPLICATE_WINDOW_MS = EVIDENCE_BURST_WINDOW_MS

// Relative time unit sent to the AI (state equations are in days).
export const MS_PER_DAY = 86_400_000

// Stable machine-readable exclusion reasons (never physician-facing text).
export const CLINICAL_EXCLUSION = {
  INVALID:             'INVALID',
  OUT_OF_DOMAIN:       'OUT_OF_DOMAIN',
  AMBIGUOUS_TIMESTAMP: 'AMBIGUOUS_TIMESTAMP',
  DUPLICATE_OF_ANCHOR: 'DUPLICATE_OF_ANCHOR',
} as const
export type ClinicalExclusionReason = typeof CLINICAL_EXCLUSION[keyof typeof CLINICAL_EXCLUSION]

// Personalization status: EXACTLY the Prisma enum PersonalizationStatus.
export const PERSONALIZATION_STATUSES = [
  'INDIVIDUALIZED',
  'GLOBAL_INSUFFICIENT_HISTORY',
  'GLOBAL_INCOMPATIBLE_HISTORY',
  'GLOBAL_ERROR_FALLBACK',
] as const

// Backend-integration fallback reasons (machine-readable, never UI text).
export const BACKEND_PERSONALIZATION_REASON = {
  EVIDENCE_EXTRACTION_FAILED:          'EVIDENCE_EXTRACTION_FAILED',
  AI_PERSONALIZATION_RESPONSE_INVALID: 'AI_PERSONALIZATION_RESPONSE_INVALID',
} as const
export type BackendPersonalizationReason =
  typeof BACKEND_PERSONALIZATION_REASON[keyof typeof BACKEND_PERSONALIZATION_REASON]

// Provenance JSON layout version (audit document, not a model contract).
export const PERSONALIZATION_PROVENANCE_SCHEMA = 'R-BPBC-3/provenance-1' as const
