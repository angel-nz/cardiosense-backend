// NEW S2B → S3 — S-FEAT-ROBUST-TREND-1 target-state simulation, target dates,
// admissibility and contiguous horizon truncation. (Supersedes S-FEAT-LOCF-1.)
//
// Continuous indicators (totChol, sysBP, diaBP, BMI, glucose):
//   futureValue = anchorValue + effectiveSlope × daysAhead
// with daysAhead = targetDate − anchor clinical day (integer Guadalajara
// calendar days). EVERY horizon is computed DIRECTLY from the REAL history
// trend + REAL anchor + its own target date — never from another horizon's
// simulated state (no recursive simulation).
// Only the 11-feature model-input type semantics are applied afterwards.
// Nothing is clamped: an inadmissible
// state truncates the horizons from that point on.
// Discrete states are NOT forecast (no invented intervention / state change):
// age DERIVED from birthDate, sex = patient, currentSmoker / BPMeds /
// diabetes CARRY_FORWARD, cigsPerDay CONDITIONAL (0 when not a smoker).

import { calculateAge } from '@/lib/age'
import {
  MAX_HORIZONS, SEQ_WEIGHT_LATEST_REAL, SEQ_WEIGHT_ORDINARY_REAL, SEQ_WEIGHT_SCALE, SEQ_WEIGHT_SIMULATED, TREND_FEATURES,
} from './constants'
import { addCalendarDays, calendarDateToUTCDate, calendarDayDiff, effectiveClinicalInstant } from './clinicalTime'
import { featureValue, weightedTheilSen, type TrendFeature } from './trend'
import { stateAdmissibilityIssue } from './validity'
import type {
  SFeatureProvenance, SFeatureTrend, SModelContractInput, SPatientInput, SPlanGenerationStatus, SPlannedTarget,
  SRealRecordInput, SSequentialContext, SSimulatedState, SWeightedFeatureTrend,
} from './types'

// Integer fields of the model-input contract: the project's deterministic
// round-half-up (toward +∞ at exact halves). Non-finite stays non-finite.
// The value is first snapped to 9 decimals so a binary-floating residue of an
// exact half (e.g. 77.49999999999999 for 77.5) still rounds UP.
export const roundHalfUp = (x: number): number => (Number.isFinite(x) ? Math.floor(Number(x.toFixed(9)) + 0.5) : x)

export function featureProvenanceFor(trends: Readonly<Record<TrendFeature, SFeatureTrend>>): Readonly<Record<keyof SSimulatedState, SFeatureProvenance>> {
  const dyn = (f: TrendFeature): SFeatureProvenance => (trends[f].effectiveSlope === 0 ? 'ROBUST_TREND_FLAT' : 'ROBUST_TREND')
  return Object.freeze({
    age:           'DERIVED',
    sex:           'CARRY_FORWARD',
    currentSmoker: 'CARRY_FORWARD',
    cigsPerDay:    'CONDITIONAL',
    BPMeds:        'CARRY_FORWARD',
    diabetes:      'CARRY_FORWARD',
    totChol:       dyn('totChol'),
    sysBP:         dyn('sysBP'),
    diaBP:         dyn('diaBP'),
    BMI:           dyn('BMI'),
    glucose:       dyn('glucose'),
  })
}

// Calendar age at a pure target DATE from the CURRENT patient birthDate.
export function ageOnDate(birthDate: string, isoDate: string): number {
  return calculateAge(calendarDateToUTCDate(birthDate), calendarDateToUTCDate(isoDate))
}

// Pure, per-horizon: depends only on (patient, REAL anchor, anchor day, REAL
// trends, target date).
export function simulateTargetState(
  patient: SPatientInput, anchor: SRealRecordInput, anchorDay: string, targetDate: string,
  trends: Readonly<Record<TrendFeature, { effectiveSlope: number }>>,
): { state: SSimulatedState; flags: { cigsForcedZero: boolean; ageChangedFromAnchor: boolean } } {
  const smoker: 0 | 1 = anchor.currentSmoker ? 1 : 0
  const cigsForcedZero = smoker === 0 && anchor.cigsPerDay !== 0
  const age = ageOnDate(patient.birthDate, targetDate)
  const daysAhead = calendarDayDiff(anchorDay, targetDate)
  const future = (f: TrendFeature) => featureValue(anchor, f) + trends[f].effectiveSlope * daysAhead
  const dynamic = Object.fromEntries(TREND_FEATURES.map(f => [f, future(f)])) as Record<TrendFeature, number>
  const state: SSimulatedState = {
    age,
    sex:           patient.sex,
    currentSmoker: smoker,
    cigsPerDay:    smoker === 1 ? anchor.cigsPerDay : 0,
    BPMeds:        anchor.bpMeds ? 1 : 0,
    diabetes:      anchor.diabetes ? 1 : 0,
    totChol:       dynamic.totChol,
    sysBP:         dynamic.sysBP,
    diaBP:         dynamic.diaBP,
    BMI:           dynamic.BMI,
    glucose:       dynamic.glucose,
  }
  return { state, flags: { cigsForcedZero, ageChangedFromAnchor: age !== anchor.age } }
}

// h = 1..3, targetDate(h) = cutoffLocalDay + h·Δd (pure calendar arithmetic).
// Contiguous: the first inadmissible horizon and every later one are dropped.
export function planHorizons(
  patient: SPatientInput, anchor: SRealRecordInput, cutoffLocalDay: string, deltaDays: number, model: SModelContractInput,
  trends: Readonly<Record<TrendFeature, SFeatureTrend>>,
): { status: Exclude<SPlanGenerationStatus, 'NOT_APPLICABLE'>; reason: string | null; targets: SPlannedTarget[] } {
  const targets: SPlannedTarget[] = []
  const provenance = featureProvenanceFor(trends)
  let reason: string | null = null
  for (let h = 1; h <= MAX_HORIZONS; h++) {
    const targetDate = addCalendarDays(cutoffLocalDay, h * deltaDays)
    const { state, flags } = simulateTargetState(patient, anchor, cutoffLocalDay, targetDate, trends)
    const issue = stateAdmissibilityIssue(state, model)       // complete check, every horizon, no clamping
    if (issue) {
      reason = issue === 'age_out_of_model_domain' ? 'TARGET_AGE_OUT_OF_MODEL_DOMAIN' : `TARGET_STATE_INADMISSIBLE:${issue}`
      break
    }
    targets.push({
      horizonIndex: h as 1 | 2 | 3, targetDate, targetAge: state.age, simulatedState: state,
      featureProvenance: provenance, assumptionFlags: flags,
    })
  }
  const status = targets.length === MAX_HORIZONS ? 'GENERATED_FULL' : targets.length > 0 ? 'GENERATED_PARTIAL' : 'NONE_ADMISSIBLE'
  return { status, reason, targets }
}

// ═══ NEW S4 — S-FEAT-SEQUENTIAL-ROBUST-2 + S-CAD-3 cumulative target dates ═══
//
//   targetDate(1) = anchorDay + i1, targetDate(2) = targetDate(1) + i2,
//   targetDate(3) = targetDate(2) + i3        (intervals from S-CAD-3)
//
//   F1 context = ALL usable REAL records                 (weights 1, latest 1.25)
//   F2 context = ALL usable REAL records + F1            (F1 weight 0.50)
//   F3 context = ALL usable REAL records + F1 + F2       (each 0.50)
// Every horizon is anchored on the latest REAL record:
//   F_h(feature) = latestRealValue + effectiveSlope_h × days(anchorDay → targetDate(h))
// Earlier simulated horizons only shape the fitted trend; their values are
// never an arithmetic starting point. Only the in-memory F1/F2 of THIS run
// enter the context (never a persisted forecast, a Prediction, a risk score,
// R evidence, or a forecast of another set). A simulated point sits at
// anchorInstant + days(anchorDay → targetDate) and carries its simulated
// dynamic feature values. The first inadmissible
// horizon truncates the rest (no clamping, no skipping).

export function seqProvenanceFor(trends: Readonly<Record<TrendFeature, SWeightedFeatureTrend>>): Readonly<Record<keyof SSimulatedState, SFeatureProvenance>> {
  const dyn = (f: TrendFeature): SFeatureProvenance => (trends[f].effectiveSlope === 0 ? 'SEQUENTIAL_ROBUST_FLAT' : 'SEQUENTIAL_ROBUST_TREND')
  return Object.freeze({
    age: 'DERIVED', sex: 'CARRY_FORWARD', currentSmoker: 'CARRY_FORWARD', cigsPerDay: 'CONDITIONAL', BPMeds: 'CARRY_FORWARD', diabetes: 'CARRY_FORWARD',
    totChol: dyn('totChol'), sysBP: dyn('sysBP'), diaBP: dyn('diaBP'), BMI: dyn('BMI'), glucose: dyn('glucose'),
  })
}

interface ContextPoint { id: string; t: number; w4: number; values: Record<TrendFeature, number> }

const w4 = (w: number) => Math.round(w * SEQ_WEIGHT_SCALE)

export function sequentialTrends(context: readonly ContextPoint[]): Record<TrendFeature, SWeightedFeatureTrend> {
  const ordered = [...context].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out = {} as Record<TrendFeature, SWeightedFeatureTrend>
  for (const f of TREND_FEATURES) out[f] = weightedTheilSen(ordered.map(p => ({ t: p.t, value: p.values[f], w4: p.w4 })), SEQ_WEIGHT_SCALE)
  return out
}

export function realContextPoints(realRecords: readonly SRealRecordInput[], latestRealId: string): ContextPoint[] {
  return realRecords.map(r => ({
    id: r.id, t: effectiveClinicalInstant(r).getTime(),
    w4: w4(r.id === latestRealId ? SEQ_WEIGHT_LATEST_REAL : SEQ_WEIGHT_ORDINARY_REAL),
    values: Object.fromEntries(TREND_FEATURES.map(f => [f, featureValue(r, f)])) as Record<TrendFeature, number>,
  }))
}

export function planSequentialHorizons(
  patient: SPatientInput, anchor: SRealRecordInput, cutoffLocalDay: string, intervalsDays: readonly [number, number, number],
  realRecords: readonly SRealRecordInput[], model: SModelContractInput,
  opts: { excludeSimulated?: ReadonlyArray<'F1' | 'F2'> } = {},
): { status: Exclude<SPlanGenerationStatus, 'NOT_APPLICABLE'>; reason: string | null; targets: SPlannedTarget[]; f1Trends: Record<TrendFeature, SWeightedFeatureTrend> } {
  const real = realContextPoints(realRecords, anchor.id)
  const anchorT = effectiveClinicalInstant(anchor).getTime()
  const simulated: ContextPoint[] = []
  const targets: SPlannedTarget[] = []
  let reason: string | null = null
  let f1Trends: Record<TrendFeature, SWeightedFeatureTrend> | null = null
  let targetDate = cutoffLocalDay
  for (let h = 1; h <= MAX_HORIZONS; h++) {
    targetDate = addCalendarDays(targetDate, intervalsDays[h - 1])
    // opts.excludeSimulated exists ONLY for mutation/contrast tests (SEQ6/SEQ7).
    const sims = simulated.filter(p => !(opts.excludeSimulated ?? []).includes(p.id as 'F1' | 'F2'))
    const trends = sequentialTrends([...real, ...sims])
    if (h === 1) f1Trends = trends
    const { state, flags } = simulateTargetState(patient, anchor, cutoffLocalDay, targetDate, trends)
    const issue = stateAdmissibilityIssue(state, model)
    if (issue) {
      reason = issue === 'age_out_of_model_domain' ? 'TARGET_AGE_OUT_OF_MODEL_DOMAIN' : `TARGET_STATE_INADMISSIBLE:${issue}`
      break
    }
    const daysAhead = calendarDayDiff(cutoffLocalDay, targetDate)
    const sequentialContext: SSequentialContext = {
      horizonIndex: h as 1 | 2 | 3,
      realRecordCount: real.length,
      realRecordIds: real.map(p => p.id),
      latestRealRecordId: anchor.id,
      simulatedContext: sims.map(p => p.id as 'F1' | 'F2'),
      weights: { ordinaryReal: SEQ_WEIGHT_ORDINARY_REAL, latestReal: SEQ_WEIGHT_LATEST_REAL, simulated: SEQ_WEIGHT_SIMULATED },
      features: Object.fromEntries(TREND_FEATURES.map(f => [f, trends[f]])),
    }
    targets.push({
      horizonIndex: h as 1 | 2 | 3, targetDate, targetAge: state.age, simulatedState: state,
      featureProvenance: seqProvenanceFor(trends), assumptionFlags: flags, sequentialContext,
    })
    simulated.push({
      id: `F${h}`, t: anchorT + daysAhead * 86_400_000, w4: w4(SEQ_WEIGHT_SIMULATED),
      values: Object.fromEntries(TREND_FEATURES.map(f => [f, state[f]])) as Record<TrendFeature, number>,
    })
  }
  const status = targets.length === MAX_HORIZONS ? 'GENERATED_FULL' : targets.length > 0 ? 'GENERATED_PARTIAL' : 'NONE_ADMISSIBLE'
  return { status, reason, targets, f1Trends: f1Trends! }
}
