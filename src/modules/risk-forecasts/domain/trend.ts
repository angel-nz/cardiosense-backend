// NEW S3 — S-FEAT-ROBUST-TREND-1: robust per-feature trend over REAL history.
//
// Observations: the patient's REAL measured visits only (CLINICIAN_ENTERED,
// non-null measuredAt, usable, one per Guadalajara clinical day — the same
// visits S-CAD-2 uses). Legacy records never receive a fabricated measurement
// time. Never used: Prediction risk, RiskForecasts, simulated states, Alerts,
// R personalization output.
//
//   slope_ij        = (value_j − value_i) / (day_j − day_i)  for every pair i < j
//   rawSlope        = median(slope_ij)                         (Theil–Sen)
//   P / N           = #positive / #negative slopes (zeros ignored)
//   consistency     = |P − N| / (P + N)   (0 when P + N = 0)
//   effectiveSlope  = rawSlope × consistency
//
// `consistency` is a deterministic directional-agreement control that shrinks
// oscillating histories toward a flat trend. It is NOT a confidence,
// probability, calibration or clinical certainty.
// Complexity: O(n²) slopes + O(n² log n) sort per feature (n = measured
// visits); no cap is applied.
import { calendarDayDiff } from './clinicalTime'
import { TREND_FEATURES } from './constants'
import { decimalToNumber } from './validity'
import type { SFeatureTrend, SRealRecordInput, SWeightedFeatureTrend } from './types'

export type TrendFeature = (typeof TREND_FEATURES)[number]

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}
const noNegZero = (x: number) => (x === 0 ? 0 : x)

export function theilSenTrend(points: ReadonlyArray<{ day: number; value: number }>): SFeatureTrend {
  const slopes: number[] = []
  let positive = 0, negative = 0
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dd = points[j].day - points[i].day
      if (dd === 0) continue                                   // distinct clinical days only
      const s = (points[j].value - points[i].value) / dd
      slopes.push(s)
      if (s > 0) positive++
      else if (s < 0) negative++
    }
  }
  const rawSlope = slopes.length ? noNegZero(median(slopes)) : 0
  const trendConsistency = positive + negative === 0 ? 0 : Math.abs(positive - negative) / (positive + negative)
  return {
    observations: points.length, pairCount: slopes.length, rawSlope,
    positivePairs: positive, negativePairs: negative, trendConsistency,
    effectiveSlope: noNegZero(rawSlope * trendConsistency),
  }
}

export function featureValue(r: SRealRecordInput, f: TrendFeature): number {
  switch (f) {
    case 'totChol':   return decimalToNumber(r.totChol) ?? Number.NaN
    case 'sysBP':     return decimalToNumber(r.sysBP) ?? Number.NaN
    case 'diaBP':     return decimalToNumber(r.diaBP) ?? Number.NaN
    case 'BMI':       return decimalToNumber(r.bmi) ?? Number.NaN
    case 'glucose':   return decimalToNumber(r.glucose) ?? Number.NaN
  }
}

// Trends of every dynamic feature from the measured visits (ascending days).
export function computeFeatureTrends(visits: ReadonlyArray<{ day: string; record: SRealRecordInput }>): Record<TrendFeature, SFeatureTrend> {
  const day0 = visits[0]?.day
  const out = {} as Record<TrendFeature, SFeatureTrend>
  for (const f of TREND_FEATURES) {
    out[f] = theilSenTrend(visits.map(v => ({ day: calendarDayDiff(day0, v.day), value: featureValue(v.record, f) })))
  }
  return out
}

// ═══ NEW S4 — S-FEAT-SEQUENTIAL-ROBUST-2: WEIGHTED Theil–Sen ═════════════
//
// Context points carry an effective clinical INSTANT (ms) and an integer
// weight scaled ×SEQ_WEIGHT_SCALE (REAL 1 → 4, latest REAL 1.25 → 5,
// simulated 0.50 → 2) so every pair weight and cumulative sum is exact.
//   slope_ij  = (v_j − v_i) / elapsed_days(i, j)       for every pair with t_i ≠ t_j
//   w_ij      = w_i × w_j
//   rawSlope  = weighted median of slope_ij by w_ij:
//               sort slopes ascending; the first slope whose cumulative
//               weight reaches half the total; when the cumulative weight
//               equals exactly half, the midpoint with the next slope (so equal
//               weights reproduce the ordinary median exactly)
//   W+ / W−   = Σ w_ij over positive / negative slopes (zeros contribute 0)
//   trendConsistency = |W+ − W−| / (W+ + W−)   (0 when W+ + W− = 0)
//   effectiveSlope   = rawSlope × trendConsistency
// Exact-zero time-distance pairs are skipped (two records at the same
// instant); records on the same day at different instants both contribute.
// trendConsistency is a deterministic trend-control factor — NOT a
// confidence, probability, certainty or calibration.
const MS_PER_DAY = 86_400_000

export interface WeightedPoint { t: number; value: number; w4: number }

export function weightedTheilSen(points: readonly WeightedPoint[], scale: number): SWeightedFeatureTrend {
  const pairs: Array<{ s: number; w: number }> = []
  let wPos = 0, wNeg = 0
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dtMs = points[j].t - points[i].t
      if (dtMs === 0) continue
      const s = (points[j].value - points[i].value) / (dtMs / MS_PER_DAY)
      const w = points[i].w4 * points[j].w4
      pairs.push({ s, w })
      if (s > 0) wPos += w
      else if (s < 0) wNeg += w
    }
  }
  let rawSlope = 0
  if (pairs.length) {
    pairs.sort((a, b) => a.s - b.s)
    const total = pairs.reduce((acc, p) => acc + p.w, 0)
    let cum = 0
    for (let k = 0; k < pairs.length; k++) {
      cum += pairs[k].w
      if (2 * cum > total) { rawSlope = pairs[k].s; break }
      if (2 * cum === total) { rawSlope = k + 1 < pairs.length ? (pairs[k].s + pairs[k + 1].s) / 2 : pairs[k].s; break }
    }
  }
  rawSlope = noNegZero(rawSlope)
  const sq = scale * scale
  const trendConsistency = wPos + wNeg === 0 ? 0 : Math.abs(wPos - wNeg) / (wPos + wNeg)
  return {
    pairCount: pairs.length, rawSlope,
    positiveWeight: wPos / sq, negativeWeight: wNeg / sq,
    trendConsistency, effectiveSlope: noNegZero(rawSlope * trendConsistency),
  }
}
