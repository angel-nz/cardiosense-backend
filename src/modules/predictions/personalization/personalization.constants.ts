// NEW R (R4B) — single canonical home of the backend-owned evidence-policy
// constants of the frozen personalization contract.
//
// Contract: personalizationVersion "R-BPBC-1", parameter set
// "R-BPBC-1 / 2026-10-02 final" (NEW R3 + R3-FIX1 + R3-FIX2).
//
// Only the EVIDENCE-POLICY parameters the backend owns live here. The
// state-model / γ / bound parameters (r_k, q_k, P_floor, B, change guard,
// G mapping, finite-difference rules) belong to the AI service (R4C) and are
// deliberately NOT duplicated in the backend.

export const PERSONALIZATION_VERSION = 'R-BPBC-1' as const

// Δ_min — ENGINEERING anti-duplicate / information-cap window (R3-FIX1 item 3).
// recordedAt is system-entry ("known-at") time, so this is NOT a clinical
// visit, measurement window or physiological-change limit. Anchored-start,
// half-open: a burst started at s contains records with recordedAt < s + Δ_min.
export const EVIDENCE_BURST_WINDOW_MS = 60 * 60 * 1000

// Same Δ_min, applied to the anchor-duplicate rule (R3 item 2 step 4):
// a prior record with anchor.recordedAt − record.recordedAt < this window and
// an identical clinical state to the anchor is DUPLICATE_OF_ANCHOR.
export const ANCHOR_DUPLICATE_WINDOW_MS = EVIDENCE_BURST_WINDOW_MS

// Relative time unit sent to the AI (R3 state equations are in days).
export const MS_PER_DAY = 86_400_000

// Stable machine-readable exclusion reasons (never physician-facing text).
export const CLINICAL_EXCLUSION = {
  INVALID:             'INVALID',
  OUT_OF_DOMAIN:       'OUT_OF_DOMAIN',
  AMBIGUOUS_TIMESTAMP: 'AMBIGUOUS_TIMESTAMP',
  DUPLICATE_OF_ANCHOR: 'DUPLICATE_OF_ANCHOR',
} as const
export type ClinicalExclusionReason = typeof CLINICAL_EXCLUSION[keyof typeof CLINICAL_EXCLUSION]

// ─── NEW R (R4E) — integration vocabulary ──────────────────────────────────
// Personalization status: EXACTLY the Prisma enum PersonalizationStatus
// (R3 / R4A / R4C-FIX1). The `satisfies` check in personalization.outcome.ts
// keeps this list and the generated Prisma enum identical at compile time.
export const PERSONALIZATION_STATUSES = [
  'INDIVIDUALIZED',
  'GLOBAL_INSUFFICIENT_HISTORY',
  'GLOBAL_INCOMPATIBLE_HISTORY',
  'GLOBAL_ERROR_FALLBACK',
] as const

// Backend-integration fallback reasons (machine-readable, never UI text).
// Every other persisted reason is the AI (R4C/R4D) reason, stored unchanged.
export const BACKEND_PERSONALIZATION_REASON = {
  // R4B evidence extraction threw before the AI call → ONE global-only AI call.
  EVIDENCE_EXTRACTION_FAILED:          'EVIDENCE_EXTRACTION_FAILED',
  // Evidence was sent, the AI returned a valid GLOBAL result, but its
  // `personalization` block was missing / malformed / inconsistent.
  AI_PERSONALIZATION_RESPONSE_INVALID: 'AI_PERSONALIZATION_RESPONSE_INVALID',
} as const
export type BackendPersonalizationReason =
  typeof BACKEND_PERSONALIZATION_REASON[keyof typeof BACKEND_PERSONALIZATION_REASON]

// Provenance JSON layout version (audit document, not a model contract).
export const PERSONALIZATION_PROVENANCE_SCHEMA = 'R-BPBC-1/provenance-1' as const
