// NEW S2B — thin, type-only adapters from the S2A Prisma shapes to the pure
// domain inputs. No queries here (persistence/orchestration is S2C+).
import type { HealthRecord, Patient } from '@prisma/client'
import { utcDateToISODate } from '@/lib/timezone'
import type { AIPredictionInput } from '@/lib/aiInput'
import type { SPatientInput, SRealRecordInput, SSimulatedState } from './types'

export function toSPatientInput(p: Pick<Patient, 'id' | 'birthDate' | 'sex' | 'isActive' | 'isHidden'>): SPatientInput {
  return { patientId: p.id, birthDate: utcDateToISODate(p.birthDate), sex: p.sex, isActive: p.isActive, isHidden: p.isHidden }
}

export function toSRealRecordInput(r: Pick<HealthRecord,
  'id' | 'recordedAt' | 'measuredAt' | 'clinicalTimeSource' | 'age' | 'currentSmoker' | 'cigsPerDay' | 'bpMeds' |
  'diabetes' | 'totChol' | 'sysBP' | 'diaBP' | 'bmi' | 'glucose'>): SRealRecordInput {
  return {
    id: r.id, recordedAt: r.recordedAt, measuredAt: r.measuredAt, clinicalTimeSource: r.clinicalTimeSource,
    age: r.age, currentSmoker: r.currentSmoker, cigsPerDay: r.cigsPerDay, bpMeds: r.bpMeds, diabetes: r.diabetes,
    totChol: r.totChol, sysBP: r.sysBP, diaBP: r.diaBP, bmi: r.bmi, glucose: r.glucose,
  }
}

// Compile-time proof that a simulated state is exactly a /predict body.
type AssertAssignable<A extends B, B> = A
export type _SimulatedStateIsPredictInput = AssertAssignable<SSimulatedState, AIPredictionInput>
