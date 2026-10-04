// NEW S2B — public surface of the pure S forecast-planning engine.
// Domain only: no persistence, no AI, no R, no Prediction history.
export * from './constants'
export * from './types'
export { planForecast, lifecycleOf, buildMeasuredVisits } from './planner'
export { sCad2, sCad3, roundHalfUpPositive, classifyGap, multimodalSplit } from './cadence'
export { theilSenTrend, computeFeatureTrends, weightedTheilSen } from './trend'
export { sortByClinicalOrder, effectiveClinicalInstant, localClinicalDay, addCalendarDays, calendarDayDiff } from './clinicalTime'
export { classifyRecord, stateAdmissibilityIssue, canonicalDecimal } from './validity'
export { simulateTargetState, planHorizons, ageOnDate, featureProvenanceFor, roundHalfUp, planSequentialHorizons, sequentialTrends, realContextPoints, seqProvenanceFor } from './simulation'
export { computeInputFingerprint, canonicalFingerprintPayload } from './fingerprint'
