// NEW S3 — S-CAD-2 (supersedes S-CAD-1). NEW S4 — S-CAD-3 (supersedes S-CAD-2
// for NEW sets; sCad2 stays for historical verification). S-CAD-3 shares the
// unimodal core below unchanged and adds a two-mode transition path.
//
// Input: chronologically ordered POSITIVE INTEGER visit gaps (days) between
// REAL measured visits (one per Guadalajara clinical day). Every comparison
// is exact integer cross-multiplication — no floating-point division:
//   • medians are kept doubled (2m is always an integer);
//   • the tolerance test |g − k·m| ≤ max(2, m/2) is evaluated ×4.
// "Possible missed visit" is ONLY a cadence diagnostic: no virtual visit,
// record or evidence is ever created. There is no fallback cadence:
// abstention is an explicit result.

import {
  CAD_DELTA_MAX_DAYS, CAD_DELTA_MIN_DAYS, CAD_MIN_VISITS, CAD2_MIN_DIRECT_SHARE, CAD2_MIN_EXPLAINED_SHARE,
  CAD2_MISSED_MULTIPLES, CAD2_SPLIT_MIN_SHARE, CAD2_SPLIT_RATIO, CAD2_TOLERANCE_MIN_DAYS, CAD2_WINDOW_GAPS,
  CAD3_MIN_MODE_MEMBERS,
} from './constants'
import { SInputContractError, type SCadenceDiagnostics, type SCadenceModes, type SCadenceResult } from './types'

// 2 × median (always an integer for integer inputs; even count → midpoint).
export function twiceMedian(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? 2 * s[(n - 1) / 2] : s[n / 2 - 1] + s[n / 2]
}

// Round half up, for positive values (deltaRaw ≥ 1): 7.5 → 8, 14.5 → 15.
export function roundHalfUpPositive(x: number): number {
  if (!(x > 0)) throw new SInputContractError(`round-half-up expects a positive value, got ${x}`)
  return Math.floor(x + 0.5)
}

export type GapClass = 'DIRECT' | 'POSSIBLE_MISSED_VISIT' | 'UNEXPLAINED'

// |g − k·m| ≤ max(2, m/2)  ⇔  |4g − 2k·M2| ≤ max(8, M2)   with M2 = 2m.
export function classifyGap(g: number, m2: number): GapClass {
  const tol4 = Math.max(4 * CAD2_TOLERANCE_MIN_DAYS, m2)
  if (Math.abs(4 * g - 2 * m2) <= tol4) return 'DIRECT'
  for (const k of CAD2_MISSED_MULTIPLES) if (Math.abs(4 * g - 2 * k * m2) <= tol4) return 'POSSIBLE_MISSED_VISIT'
  return 'UNEXPLAINED'
}

// Step 1 — largest multiplicative split of the ascending window. Abstains
// when ratio ≥ 1.8 AND both partitions hold ≥ 40 % of the gaps. When several
// adjacent pairs share the maximal ratio, any of them meeting the partition
// rule abstains (deterministic, order-independent).
export function multimodalSplit(window: readonly number[]): { ratioNum: number; ratioDen: number; lower: number; upper: number; multimodal: boolean } {
  const s = [...window].sort((a, b) => a - b)
  const n = s.length
  let best: { i: number; num: number; den: number }[] = []
  for (let i = 0; i < n - 1; i++) {
    const num = s[i + 1], den = s[i]
    if (best.length === 0 || num * best[0].den > best[0].num * den) best = [{ i, num, den }]
    else if (num * best[0].den === best[0].num * den) best.push({ i, num, den })
  }
  const top = best[0]
  const share = (k: number) => k * CAD2_SPLIT_MIN_SHARE.den >= n * CAD2_SPLIT_MIN_SHARE.num
  const ratioOk = top.num * CAD2_SPLIT_RATIO.den >= top.den * CAD2_SPLIT_RATIO.num
  const hit = ratioOk ? best.find(b => share(b.i + 1) && share(n - b.i - 1)) : undefined
  const chosen = hit ?? top
  return { ratioNum: chosen.num, ratioDen: chosen.den, lower: chosen.i + 1, upper: n - chosen.i - 1, multimodal: !!hit }
}

function validateGaps(gaps: readonly number[], policy: string): void {
  for (const g of gaps) {
    if (!Number.isInteger(g) || g < 1) throw new SInputContractError(`${policy} gaps must be positive integers, got ${g}`)
  }
}

// Unimodal core (S-CAD-2 steps 2–3, unchanged): robust median candidate,
// DIRECT / POSSIBLE_MISSED_VISIT / UNEXPLAINED classification, support
// (explained ≥ 0.80, direct ≥ 0.60), delta = median of DIRECT gaps, bounds,
// round-half-up. Output intervals [d, d, d].
function unimodalCadence(window: readonly number[], split: SCadenceDiagnostics['split']): SCadenceResult {
  const n = window.length
  const m2 = twiceMedian(window)
  const classes = window.map(g => classifyGap(g, m2))
  const direct = window.filter((_, i) => classes[i] === 'DIRECT')
  const missed = classes.filter(c => c === 'POSSIBLE_MISSED_VISIT').length
  const explained = direct.length + missed
  const diagnostics: SCadenceDiagnostics = { window: [...window], split, medianAll: m2 / 2, classes }
  // Support: explained ≥ 0.80, direct ≥ 0.60
  if (explained * CAD2_MIN_EXPLAINED_SHARE.den < n * CAD2_MIN_EXPLAINED_SHARE.num ||
      direct.length * CAD2_MIN_DIRECT_SHARE.den < n * CAD2_MIN_DIRECT_SHARE.num) {
    return { status: 'ABSTAIN', reason: 'NO_DOMINANT_CADENCE', diagnostics }
  }
  // Final delta = median of DIRECT gaps only
  const deltaRaw = twiceMedian(direct) / 2
  if (deltaRaw < CAD_DELTA_MIN_DAYS || deltaRaw > CAD_DELTA_MAX_DAYS) return { status: 'ABSTAIN', reason: 'DELTA_OUT_OF_BOUNDS', diagnostics }
  const d = roundHalfUpPositive(deltaRaw)
  return {
    status: 'OK', deltaRaw, deltaDays: d, intervalsDays: [d, d, d],
    method: missed > 0 ? 'ROBUST_MEDIAN_WITH_MISSED_VISITS' : 'ROBUST_MEDIAN',
    diagnostics, multimodal: null,
  }
}

// S-CAD-2 (historical policy; NEW sets use sCad3): multimodal ⇒ abstain.
export function sCad2(gaps: readonly number[]): SCadenceResult {
  validateGaps(gaps, 'S-CAD-2')
  if (gaps.length < CAD_MIN_VISITS - 1) return { status: 'ABSTAIN', reason: 'TOO_FEW_GAPS', diagnostics: null }
  const window = gaps.slice(-CAD2_WINDOW_GAPS)              // newest ≤ 8 gaps
  const split = multimodalSplit(window)
  if (split.multimodal) {
    return { status: 'ABSTAIN', reason: 'MULTIMODAL_CADENCE', diagnostics: { window: [...window], split, medianAll: null, classes: null } }
  }
  return unimodalCadence(window, split)
}

// NEW S4 — S-CAD-3.
//   1. window = newest ≤ 8 gaps; S-CAD-2 multiplicative split evidence.
//   2. NOT multimodal → the unimodal core above (missed visits included):
//      e.g. 7,7,15,7,7 → [7,7,7]; 3,5,6,3,7 → [5,5,5].
//   3. multimodal (two modes, split between the sorted values at the
//      split point; a gap ≤ the lower partition's maximum is L, else H):
//      • reliability: each mode has ≥ 2 members and EVERY member is DIRECT
//        w.r.t. its own mode median (S-CAD-2 tolerance T = max(2, m/2)),
//        else ABSTAIN MULTIMODAL_UNRELIABLE (chaotic cadences);
//      • mode value = robust median of its members, round-half-up; outside
//        1..120 → ABSTAIN MODE_OUT_OF_BOUNDS;
//      • first-order transition rule on the chronological labels: from the
//        current mode take the most frequent observed successor; count tie →
//        the successor of the MOST RECENT observed transition from that mode;
//        no outgoing transition → the other mode. The same fixed table is
//        applied for all three future steps. Counts are NOT probabilities.
//      e.g. 7,21,7,21,7,21 → L,H,L,H,L,H → next L,H,L → [7,21,7] (never 14).
export function sCad3(gaps: readonly number[]): SCadenceResult {
  validateGaps(gaps, 'S-CAD-3')
  if (gaps.length < CAD_MIN_VISITS - 1) return { status: 'ABSTAIN', reason: 'TOO_FEW_GAPS', diagnostics: null }
  const window = gaps.slice(-CAD2_WINDOW_GAPS)
  const split = multimodalSplit(window)
  if (!split.multimodal) return unimodalCadence(window, split)

  const sorted = [...window].sort((a, b) => a - b)
  const lowerMax = sorted[split.lower - 1]
  const labels = window.map(g => (g <= lowerMax ? 'L' : 'H') as 'L' | 'H')
  const diagnostics: SCadenceDiagnostics = { window: [...window], split, medianAll: twiceMedian(window) / 2, classes: null }
  const modeOf = (label: 'L' | 'H') => {
    const members = window.filter((_, i) => labels[i] === label)
    const m2 = twiceMedian(members)
    return { label, members, m2, valueRaw: m2 / 2 }
  }
  const L = modeOf('L'), H = modeOf('H')
  for (const m of [L, H]) {
    if (m.members.length < CAD3_MIN_MODE_MEMBERS || m.members.some(g => classifyGap(g, m.m2) !== 'DIRECT')) {
      return { status: 'ABSTAIN', reason: 'MULTIMODAL_UNRELIABLE', diagnostics }
    }
    if (m.valueRaw < CAD_DELTA_MIN_DAYS || m.valueRaw > CAD_DELTA_MAX_DAYS) return { status: 'ABSTAIN', reason: 'MODE_OUT_OF_BOUNDS', diagnostics }
  }
  const value = { L: roundHalfUpPositive(L.valueRaw), H: roundHalfUpPositive(H.valueRaw) }
  if (value.L > CAD_DELTA_MAX_DAYS || value.H > CAD_DELTA_MAX_DAYS) return { status: 'ABSTAIN', reason: 'MODE_OUT_OF_BOUNDS', diagnostics }
  const transitions = { LL: 0, LH: 0, HL: 0, HH: 0 }
  const lastSuccessor: Partial<Record<'L' | 'H', 'L' | 'H'>> = {}
  for (let i = 1; i < labels.length; i++) {
    transitions[`${labels[i - 1]}${labels[i]}` as keyof typeof transitions]++
    lastSuccessor[labels[i - 1]] = labels[i]                       // most recent transition from that mode
  }
  const next = (cur: 'L' | 'H'): 'L' | 'H' => {
    const other = cur === 'L' ? 'H' : 'L'
    const toSame = transitions[`${cur}${cur}` as keyof typeof transitions]
    const toOther = transitions[`${cur}${other}` as keyof typeof transitions]
    if (toSame + toOther === 0) return other
    if (toSame !== toOther) return toSame > toOther ? cur : other
    return lastSuccessor[cur] ?? other
  }
  const latestMode = labels[labels.length - 1]
  const sequence: Array<'L' | 'H'> = []
  let cur = latestMode
  for (let k = 0; k < 3; k++) { cur = next(cur); sequence.push(cur) }
  const modes: SCadenceModes = {
    modes: [L, H].map(m => ({ label: m.label, members: m.members, valueRaw: m.valueRaw, valueDays: value[m.label] })),
    labels, transitions, latestMode, sequence,
  }
  return {
    status: 'OK', deltaRaw: null, deltaDays: null,
    intervalsDays: [value[sequence[0]], value[sequence[1]], value[sequence[2]]],
    method: 'MULTIMODAL_TRANSITION', diagnostics, multimodal: modes,
  }
}
