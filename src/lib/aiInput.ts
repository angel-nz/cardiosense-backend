import type { HealthRecord } from '@prisma/client'

// Canonical conversion of HealthRecord clinical values into the current
// 11-input AI wire semantics. The AI Service owns and reports the model
// contract/version. Every value here is a JSON primitive number — never a
// Prisma.Decimal, string, or raw boolean.

// The record-level part of the contract: every input that comes from the
// HealthRecord itself (everything except `sex`, which is patient-level).
// Declared as type aliases (not interfaces) so they are structurally
// assignable to Prisma's JSON input type for persistence.
export type CanonicalRecordMeasurements = {
  age:           number
  currentSmoker: 0 | 1
  cigsPerDay:    number
  BPMeds:        0 | 1
  diabetes:      0 | 1
  totChol:       number
  sysBP:         number
  diaBP:         number
  BMI:           number
  glucose:       number
}

// The full 11-value /predict request body.
export type AIPredictionInput = CanonicalRecordMeasurements & {
  // 0 = female, 1 = male — Paciente.sex as read at prediction time.
  sex: number
}

type RecordClinicalFields = Pick<
  HealthRecord,
  'age' | 'currentSmoker' | 'cigsPerDay' | 'bpMeds' | 'diabetes' |
  'totChol' | 'sysBP' | 'diaBP' | 'bmi' | 'glucose'
>

export function canonicalRecordMeasurements(record: RecordClinicalFields): CanonicalRecordMeasurements {
  return {
    age:           record.age,
    currentSmoker: record.currentSmoker ? 1 : 0,
    cigsPerDay:    record.cigsPerDay,
    BPMeds:        record.bpMeds ? 1 : 0,
    diabetes:      record.diabetes ? 1 : 0,
    totChol:       Number(record.totChol),
    sysBP:         Number(record.sysBP),
    diaBP:         Number(record.diaBP),
    BMI:           Number(record.bmi),
    glucose:       Number(record.glucose),
  }
}

// U4.2B — sex is the canonical Paciente.sex value, supplied by the caller
// (PredictionService.predictFromHealthRecord(), which already fetches the owned Patient for
// ownership verification). Encoding is identical end-to-end (0=female/
// 1=male; ai-service maps `"male": req.sex` with no inversion). Key order
// matches the pre-R2 payload exactly (age, sex, ...); the AI reads it as a
// JSON object, so order carries no meaning on the wire.
export function buildPredictionInput(record: RecordClinicalFields, sex: number): AIPredictionInput {
  const m = canonicalRecordMeasurements(record)
  return {
    age:           m.age,
    sex,
    currentSmoker: m.currentSmoker,
    cigsPerDay:    m.cigsPerDay,
    BPMeds:        m.BPMeds,
    diabetes:      m.diabetes,
    totChol:       m.totChol,
    sysBP:         m.sysBP,
    diaBP:         m.diaBP,
    BMI:           m.BMI,
    glucose:       m.glucose,
  }
}
