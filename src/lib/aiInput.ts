import type { HealthRecord } from '@prisma/client'

// R2 — the ONE place a HealthRecord's clinical values are converted into the
// AI Service's canonical wire semantics (global-risk-input-v1 — see
// ai-service/README.md "Feature contract"; the AI Service, not this file,
// owns and reports the contract version). Both the global /predict payload
// (buildPredictionInput) and R2's causal patient history
// (patientHistory.service.ts) use canonicalRecordMeasurements(), so the
// Decimal → number and boolean → 0/1 conversions can never drift between
// "what was predicted" and "what history describes".
//
// Every value here is a JSON primitive number — never a Prisma.Decimal
// instance, never a string, never a raw boolean — so this object is exactly
// what JSON.stringify sends to the AI and exactly what is persisted as
// Prediction.inputSnapshot.

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
  heartRate:     number
  glucose:       number
}

// The full 12-value /predict request body.
export type AIPredictionInput = CanonicalRecordMeasurements & {
  // 0 = female, 1 = male — Paciente.sex as read at prediction time.
  sex: number
}

type RecordClinicalFields = Pick<
  HealthRecord,
  'age' | 'currentSmoker' | 'cigsPerDay' | 'bpMeds' | 'diabetes' |
  'totChol' | 'sysBP' | 'diaBP' | 'bmi' | 'heartRate' | 'glucose'
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
    heartRate:     record.heartRate,
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
    heartRate:     m.heartRate,
    glucose:       m.glucose,
  }
}

// ─── R3 — longitudinal request block (contract v2, additive) ──────────────
//
// Sent ALONGSIDE the 12 global fields as `longitudinal` on /predict. It is
// NOT a model input: the AI Service's global model still reads only the 12
// canonical fields, and Prediction.inputSnapshot stays exactly those 12
// values. What was sent here is recorded instead, as returned by the AI, in
// Prediction.longitudinalSnapshot (anchor, counts, ids of records used).
//
// Shape (snake_case, the AI wire convention — see ai-service schemas.py):
//   anchor            the exact HealthRecord being predicted (R*); its
//                     recorded_at is the causal cutoff
//   history_status    'available' (history retrieved, possibly empty) |
//                     'unavailable' (retrieval failed — history is [])
//   history_available eligible prior records BEFORE the look-back cap
//                     (null when unavailable)
//   history           the most recent min(history_available, cap) eligible
//                     prior records, recorded_at ASC then id ASC
// recorded_at values are HealthRecord.recordedAt as ISO-8601 UTC — the
// CardioSense record-creation time, NOT a clinical visit/measurement date.
export type AILongitudinalHistoryItem = {
  health_record_id: string
  recorded_at:      string
  measurements:     CanonicalRecordMeasurements
}

export type AILongitudinalRequest = {
  anchor:            { health_record_id: string; recorded_at: string }
  history_status:    'available' | 'unavailable'
  history_available: number | null
  history:           AILongitudinalHistoryItem[]
}

// `history` is the R2 PatientHistoryService result (already authorized,
// causally cut, ordered, capped) or null when retrieval failed.
export function buildLongitudinalRequest(
  anchor: { id: string; recordedAt: Date },
  history: {
    eligibleCount: number
    entries: Array<{ healthRecordId: string; recordedAt: string; measurements: CanonicalRecordMeasurements }>
  } | null,
): AILongitudinalRequest {
  const anchorWire = { health_record_id: anchor.id, recorded_at: anchor.recordedAt.toISOString() }
  if (!history) {
    return { anchor: anchorWire, history_status: 'unavailable', history_available: null, history: [] }
  }
  return {
    anchor:            anchorWire,
    history_status:    'available',
    history_available: history.eligibleCount,
    history:           history.entries.map(e => ({
      health_record_id: e.healthRecordId,
      recorded_at:      e.recordedAt,
      measurements:     e.measurements,
    })),
  }
}
