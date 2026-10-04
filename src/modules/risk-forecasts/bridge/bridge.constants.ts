// NEW S2C — typed forecast-only R bridge (A1 = B).
//
// S-RBRIDGE-1 = "the typed REAL-cutoff R `appliedLogit` of an INDIVIDUALIZED
// REAL Prediction, reusable for forecast scoring as
// p_final = p_g if L == 0 else sigmoid(clamped_logit(p_g) + L)".
// Distinct from (and persisted next to) R's own personalizationVersion.
export const BRIDGE_VERSION = 'S-RBRIDGE-1' as const
