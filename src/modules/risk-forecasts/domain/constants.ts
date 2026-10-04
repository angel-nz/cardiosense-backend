// NEW S2B / S3 — immutable S policy identifiers and cadence constants.
//
// Every value here is part of the frozen S1 / S1-FIX1 / S1-FIX2 contract and
// of the deterministic input fingerprint: changing any of them MUST come with
// a new version string. None of these names reuse an old longitudinal
// version name.

// NEW S4 — S-3 supersedes S-2 (historical S-1 / S-2 sets stay untouched):
//   cadence  S-CAD-3 (supersedes S-CAD-2): unimodal path keeps S-CAD-2's
//            robust-median / missed-visit semantics; a reliably detected TWO-
//            mode cadence yields a deterministic interval SEQUENCE instead of
//            abstaining;
//   features S-FEAT-SEQUENTIAL-ROBUST-1 (supersedes S-FEAT-ROBUST-TREND-1):
//            weighted Theil–Sen over ALL usable REAL records, F2 also uses the
//            in-run F1 state, F3 also F1 + F2 (latest REAL weight 1.25,
//            simulated weight 0.50).
// S-TIME-1 is unchanged (effective clinical instant = measuredAt, legacy →
// recordedAt). S-FP-1 is unchanged: its payload carries every policy version
// string and every REAL source record, which is structurally sufficient.
// (S-2 history: S-CAD-2 + S-FEAT-ROBUST-TREND-1; S-1: S-CAD-1 + S-FEAT-LOCF-1.)
export const S_VERSION = 'S-3' as const
export const CLINICAL_TIME_POLICY_VERSION = 'S-TIME-1' as const
export const CADENCE_POLICY_VERSION = 'S-CAD-3' as const
export const FEATURE_POLICY_VERSION = 'S-FEAT-SEQUENTIAL-ROBUST-1' as const
export const FINGERPRINT_SCHEMA_VERSION = 'S-FP-1' as const

export interface SPolicyVersions {
  sVersion:                  typeof S_VERSION
  clinicalTimePolicyVersion: typeof CLINICAL_TIME_POLICY_VERSION
  cadencePolicyVersion:      typeof CADENCE_POLICY_VERSION
  featurePolicyVersion:      typeof FEATURE_POLICY_VERSION
}

export const S_POLICY_VERSIONS: Readonly<SPolicyVersions> = Object.freeze({
  sVersion:                  S_VERSION,
  clinicalTimePolicyVersion: CLINICAL_TIME_POLICY_VERSION,
  cadencePolicyVersion:      CADENCE_POLICY_VERSION,
  featurePolicyVersion:      FEATURE_POLICY_VERSION,
})

// ── S-CAD-2 (NEW S3) ─────────────────────────────────────────────────────
// All comparisons use exact integer cross-multiplication in cadence.ts.
export const CAD_MIN_VISITS = 4                                    // ⇒ ≥ 3 positive gaps
export const CAD2_WINDOW_GAPS = 8                                  // newest ≤ 8 gaps
export const CAD2_SPLIT_RATIO = { num: 9, den: 5 } as const        // multimodal split ratio ≥ 1.8
export const CAD2_SPLIT_MIN_SHARE = { num: 2, den: 5 } as const    // each side ≥ 40 %
export const CAD2_TOLERANCE_MIN_DAYS = 2                           // T = max(2, m/2)
export const CAD2_MISSED_MULTIPLES = [2, 3, 4] as const            // possible missed visits
export const CAD2_MIN_EXPLAINED_SHARE = { num: 4, den: 5 } as const // explained ≥ 0.80
export const CAD2_MIN_DIRECT_SHARE = { num: 3, den: 5 } as const   // direct ≥ 0.60
export const CAD_DELTA_MIN_DAYS = 1                                // bounds, inclusive
export const CAD_DELTA_MAX_DAYS = 120

// ── S-FEAT-ROBUST-TREND-1 (NEW S3) ───────────────────────────────────────
// Continuous indicators forecast by a Theil–Sen trend over REAL measured
// visits, shrunk by directional consistency. Discrete states are carried.
export const TREND_FEATURES = ['totChol', 'sysBP', 'diaBP', 'BMI', 'heartRate', 'glucose'] as const

// ── S-CAD-3 (NEW S4) ─────────────────────────────────────────────────────
// Multimodal path (two modes) — reuses the S-CAD-2 split evidence
// (ratio ≥ 1.8, both sides ≥ 40 %). Reliability: each mode has ≥ 2 member
// gaps and EVERY member is DIRECT w.r.t. its own mode median under the
// S-CAD-2 tolerance T = max(2, m/2); otherwise MULTIMODAL_UNRELIABLE.
// Mode value = robust median of its members, round-half-up, bounds 1..120.
export const CAD3_MIN_MODE_MEMBERS = 2

// ── S-FEAT-SEQUENTIAL-ROBUST-1 (NEW S4) ──────────────────────────────────
// Point weights of the weighted Theil–Sen context (policy constants):
export const SEQ_WEIGHT_ORDINARY_REAL = 1.0
export const SEQ_WEIGHT_LATEST_REAL = 1.25     // the clinically latest REAL record ("slight priority")
export const SEQ_WEIGHT_SIMULATED = 0.5        // an EARLIER horizon of THIS planning run
// Exact integer scaling (×4) used internally so every pair weight and every
// cumulative sum is an exact integer (1→4, 1.25→5, 0.5→2).
export const SEQ_WEIGHT_SCALE = 4

// ── Horizons ─────────────────────────────────────────────────────────────
export const MAX_HORIZONS = 3

// ── Business / clinical calendar ─────────────────────────────────────────
export const CLINICAL_TIMEZONE = 'America/Mexico_City' as const
