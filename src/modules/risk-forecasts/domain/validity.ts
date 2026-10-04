// NEW S2B — S record validity/usability and simulated-state admissibility.
//
// Single source of truth for feature ranges: the frozen clinical model-input
// contract `CreateRecordDto` (== AI PredictRequest ranges; also what the R
// evidence builder parses). It is CALLED from the outside here — never
// modified. S layers its own checks around it: finiteness, integer
// semantics, patient sex ∈ {0,1}, diaBP < sysBP, and the CURRENT Skorp age
// domain supplied by the caller. Nothing is clamped or repaired.

import { Prisma } from '@prisma/client'
import { CreateRecordDto } from '@/modules/health-records/record.dto'
import type { DecimalLike, SModelContractInput, SRealRecordInput, SRecordStatus, SSimulatedState } from './types'

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000'

// Exact decimal → JS number (null when not a finite decimal literal).
export function decimalToNumber(v: DecimalLike): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  try {
    const d = new Prisma.Decimal(String(v))
    return d.isFinite() ? d.toNumber() : null
  } catch { return null }
}

// Canonical exact decimal text (normalized: 240 / "240.00" / Decimal("240.0") → "240").
export function canonicalDecimal(v: DecimalLike): string {
  const d = new Prisma.Decimal(typeof v === 'number' ? v.toString() : String(v))
  return d.toFixed()
}

export const inModelAgeDomain = (age: number, model: SModelContractInput): boolean =>
  Number.isInteger(age) && age >= model.eligibleAgeRange.min && age <= model.eligibleAgeRange.max

// ── Shared 12-feature check (REAL records and simulated states) ───────────
// Returns null when admissible, otherwise a stable reason:
//   non_finite:<f> | non_integer:<f> | invalid_sex | out_of_range:<f> | dia_ge_sys
// (age-domain membership is checked separately by the callers).
type Twelve = Record<keyof SSimulatedState, number>

const INTEGER_FIELDS: (keyof SSimulatedState)[] = ['age', 'sex', 'currentSmoker', 'cigsPerDay', 'BPMeds', 'diabetes', 'heartRate']
const BINARY_FIELDS: (keyof SSimulatedState)[] = ['currentSmoker', 'BPMeds', 'diabetes']
const FIELD_ORDER: (keyof SSimulatedState)[] = ['age', 'sex', 'currentSmoker', 'cigsPerDay', 'BPMeds', 'diabetes', 'totChol', 'sysBP', 'diaBP', 'BMI', 'heartRate', 'glucose']
// CreateRecordDto field name → model-input name
const DTO_TO_MODEL: Record<string, keyof SSimulatedState> = {
  age: 'age', cigsPerDay: 'cigsPerDay', totChol: 'totChol', sysBP: 'sysBP', diaBP: 'diaBP',
  bmi: 'BMI', heartRate: 'heartRate', glucose: 'glucose', currentSmoker: 'currentSmoker', bpMeds: 'BPMeds', diabetes: 'diabetes',
}

export function modelInputIssue(x: Twelve): string | null {
  for (const f of FIELD_ORDER) {
    const v = x[f]
    if (typeof v !== 'number' || !Number.isFinite(v)) return `non_finite:${f}`
  }
  for (const f of INTEGER_FIELDS) if (!Number.isInteger(x[f])) return `non_integer:${f}`
  if (x.sex !== 0 && x.sex !== 1) return 'invalid_sex'
  for (const f of BINARY_FIELDS) if (x[f] !== 0 && x[f] !== 1) return `out_of_range:${f}`
  const parsed = CreateRecordDto.safeParse({
    patientId: PLACEHOLDER_UUID,
    age: x.age, currentSmoker: x.currentSmoker === 1, cigsPerDay: x.cigsPerDay,
    bpMeds: x.BPMeds === 1, diabetes: x.diabetes === 1,
    totChol: x.totChol, sysBP: x.sysBP, diaBP: x.diaBP, bmi: x.BMI, heartRate: x.heartRate, glucose: x.glucose,
  })
  if (!parsed.success) {
    const field = String(parsed.error.errors[0]?.path[0] ?? 'unknown')
    return `out_of_range:${DTO_TO_MODEL[field] ?? field}`
  }
  if (!(x.diaBP < x.sysBP)) return 'dia_ge_sys'
  return null
}

// REAL record → model-input numbers (no rounding beyond the exact decimal).
export function recordToModelInput(r: SRealRecordInput, sex: number): Record<keyof SSimulatedState, number> {
  const n = (v: DecimalLike) => decimalToNumber(v) ?? Number.NaN
  return {
    age: r.age, sex,
    currentSmoker: r.currentSmoker ? 1 : 0, cigsPerDay: r.cigsPerDay,
    BPMeds: r.bpMeds ? 1 : 0, diabetes: r.diabetes ? 1 : 0,
    totChol: n(r.totChol), sysBP: n(r.sysBP), diaBP: n(r.diaBP), BMI: n(r.bmi),
    heartRate: r.heartRate, glucose: n(r.glucose),
  }
}

// S status of a REAL record:
//   INVALID             — violates the model-input contract (incl. patient sex)
//   OUT_OF_MODEL_DOMAIN — valid, but persisted age outside the current domain
//   USABLE              — valid and in domain
export function classifyRecord(r: SRealRecordInput, patientSex: number, model: SModelContractInput): { status: SRecordStatus; issue: string | null } {
  const issue = modelInputIssue(recordToModelInput(r, patientSex))
  if (issue) return { status: 'INVALID', issue }
  if (!inModelAgeDomain(r.age, model)) return { status: 'OUT_OF_MODEL_DOMAIN', issue: 'age_out_of_model_domain' }
  return { status: 'USABLE', issue: null }
}

// Simulated target state admissibility (complete check, every horizon).
// Age-domain failure is reported distinctly as 'age_out_of_model_domain'.
export function stateAdmissibilityIssue(s: SSimulatedState, model: SModelContractInput): string | null {
  const x = s as unknown as Twelve
  if (typeof x.age === 'number' && Number.isInteger(x.age) && !inModelAgeDomain(x.age, model)) return 'age_out_of_model_domain'
  return modelInputIssue(x)
}
