// NEW S2E-FIX3 — ONE clinical-time calendar builder for EVERY calendar surface
// (Patient timeline GET /patients/:id/timeline and Dashboard calendar
// GET /dashboard/calendar). Read-path only.
//
// Placement rules (Guadalajara day boundaries come from the caller's from/to,
// already resolved by the existing timezone DTOs):
//   CLINICAL_RECORD   → the record's EFFECTIVE CLINICAL TIME:
//                       measuredAt for CLINICIAN_ENTERED, recordedAt for legacy
//                       rows (a malformed CLINICIAN_ENTERED row without
//                       measuredAt falls back to recordedAt, flagged legacy).
//   PREDICTION        → ONLY origin = AUTOMATIC_HEALTH_RECORD, placed at its
//                       SOURCE record's effective clinical time (never at
//                       predictedAt, which is returned only as calculation time).
//   LEGACY_UNKNOWN    → never an event and never "automatic": listed neutrally in
//                       the source record's metadata (historicalPredictions,
//                       predictedAt DESC). NEW S2E-FIX4 — MANUAL no longer exists.
//   RISK_CHANGE       → derived from consecutive AUTOMATIC predictions in clinical
//                       order (LEGACY_UNKNOWN never feeds the chain). NEW S3 —
//                       alert-like, so it is placed at its GENERATED time: the
//                       current automatic Prediction's predictedAt (there is no
//                       persisted Alert row representing exactly this event).
//                       The source record's clinical time stays in metadata.
//                       (Supersedes S2E-FIX4's clinical-time placement.)
// Ordering: event instant (clinical for records/predictions, generated for
// risk changes) → recordedAt → record id → type (record, prediction, risk
// change) → predictedAt → id.
//
// R/S never call this module; it does not change any R evidence query,
// Prediction canonicalization or S read path.
import type { Prisma, ClinicalTimeSource, PredictionOrigin } from '@prisma/client'
import { prisma } from '@/config/prisma'
import {
  buildHealthRecordGroupId,
  type ClinicalRecordTimelineEvent, type PatientTimelineEvent, type PredictionTimelineEvent, type RiskChangeTimelineEvent,
} from './patient.timeline'

export interface ClinicalTimeFields { clinicalTimeSource: ClinicalTimeSource; measuredAt: Date | null; recordedAt: Date }

export function isMeasured(r: ClinicalTimeFields): boolean {
  return r.clinicalTimeSource === 'CLINICIAN_ENTERED' && r.measuredAt !== null
}

export function effectiveClinicalTime(r: ClinicalTimeFields): Date {
  return isMeasured(r) ? (r.measuredAt as Date) : r.recordedAt
}

// [from, to) on the EFFECTIVE clinical time, expressed in Prisma (no raw SQL).
export function clinicalRangeWhere(from?: Date, to?: Date): Prisma.HealthRecordWhereInput {
  if (!from && !to) return {}
  const range = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) }
  return {
    OR: [
      { clinicalTimeSource: 'CLINICIAN_ENTERED', measuredAt: range },
      { OR: [{ clinicalTimeSource: 'LEGACY_ENTRY_TIME' }, { measuredAt: null }], recordedAt: range },
    ],
  }
}

export interface HistoricalPredictionSummary {
  predictionId: string
  origin:       Extract<PredictionOrigin, 'LEGACY_UNKNOWN'>
  predictedAt:  string           // CALCULATION time — not a clinical time
  riskScore:    number
  riskLevel:    string
  modelVersion: string | null
}

const RECORD_SELECT = {
  id: true, patientId: true, recordedAt: true, measuredAt: true, clinicalTimeSource: true, sysBP: true, diaBP: true,
} as const
const PREDICTION_SELECT = {
  id: true, patientId: true, healthRecordId: true, predictedAt: true, riskScore: true, riskLevel: true,
  isAnomaly: true, anomalyScore: true, modelVersion: true, origin: true,
} as const

type Keyed = { event: PatientTimelineEvent; k: [number, number, string, number, number, string] }
const TYPE_PRIORITY = { CLINICAL_RECORD: 0, PREDICTION: 1, RISK_CHANGE: 2 } as const

function compareKeys(a: Keyed['k'], b: Keyed['k']): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x === y) continue
    return x < y ? -1 : 1
  }
  return 0
}

export async function buildClinicalCalendarEvents(scope: Prisma.HealthRecordWhereInput, from?: Date, to?: Date): Promise<PatientTimelineEvent[]> {
  const records = await prisma.healthRecord.findMany({ where: { AND: [scope, clinicalRangeWhere(from, to)] }, select: RECORD_SELECT })
  const predictions = records.length ? await prisma.prediction.findMany({ where: { healthRecordId: { in: records.map(r => r.id) } }, select: PREDICTION_SELECT }) : []
  const recordById = new Map(records.map(r => [r.id, r]))
  const keyed: Keyed[] = []

  // Historical (LEGACY_UNKNOWN) predictions, per source record.
  const extrasByRecord = new Map<string, HistoricalPredictionSummary[]>()
  for (const p of predictions) {
    if (p.origin !== 'LEGACY_UNKNOWN' || !p.healthRecordId) continue
    const list = extrasByRecord.get(p.healthRecordId) ?? []
    list.push({ predictionId: p.id, origin: p.origin, predictedAt: p.predictedAt.toISOString(), riskScore: Number(p.riskScore), riskLevel: p.riskLevel, modelVersion: p.modelVersion })
    extrasByRecord.set(p.healthRecordId, list)
  }

  for (const r of records) {
    const eff = effectiveClinicalTime(r)
    const historicalPredictions = (extrasByRecord.get(r.id) ?? []).sort((a, b) => (a.predictedAt < b.predictedAt ? 1 : a.predictedAt > b.predictedAt ? -1 : a.predictionId < b.predictionId ? 1 : -1))
    const event: ClinicalRecordTimelineEvent = {
      id: r.id, patientId: r.patientId, eventType: 'CLINICAL_RECORD', eventDate: eff.toISOString(),
      metadata: {
        healthRecordId: r.id, sysBP: Number(r.sysBP), diaBP: Number(r.diaBP),
        clinicalTimeSource: isMeasured(r) ? 'CLINICIAN_ENTERED' : 'LEGACY_ENTRY_TIME',
        recordedAt: r.recordedAt.toISOString(),
        historicalPredictions,
      },
      groupId: buildHealthRecordGroupId(r.patientId, r.id),
    }
    keyed.push({ event, k: [eff.getTime(), r.recordedAt.getTime(), r.id, TYPE_PRIORITY.CLINICAL_RECORD, 0, r.id] })
  }

  // AUTOMATIC predictions → events at the source record's clinical time.
  const automatic = predictions
    .filter(p => p.origin === 'AUTOMATIC_HEALTH_RECORD' && p.healthRecordId && recordById.has(p.healthRecordId))
    .map(p => {
      const r = recordById.get(p.healthRecordId as string)!
      return { p, r, eff: effectiveClinicalTime(r) }
    })
    .sort((a, b) => compareKeys(
      [a.eff.getTime(), a.r.recordedAt.getTime(), a.r.id, 0, a.p.predictedAt.getTime(), a.p.id],
      [b.eff.getTime(), b.r.recordedAt.getTime(), b.r.id, 0, b.p.predictedAt.getTime(), b.p.id]))
  for (const { p, r, eff } of automatic) {
    const event: PredictionTimelineEvent = {
      id: p.id, patientId: p.patientId, eventType: 'PREDICTION', eventDate: eff.toISOString(),
      metadata: {
        predictionId: p.id, healthRecordId: p.healthRecordId, riskScore: Number(p.riskScore), riskLevel: p.riskLevel,
        isAnomaly: p.isAnomaly, anomalyScore: p.anomalyScore == null ? null : Number(p.anomalyScore), modelVersion: p.modelVersion,
        origin: 'AUTOMATIC_HEALTH_RECORD', predictedAt: p.predictedAt.toISOString(),
        clinicalTimeSource: isMeasured(r) ? 'CLINICIAN_ENTERED' : 'LEGACY_ENTRY_TIME',
      },
      groupId: buildHealthRecordGroupId(p.patientId, r.id),
    }
    keyed.push({ event, k: [eff.getTime(), r.recordedAt.getTime(), r.id, TYPE_PRIORITY.PREDICTION, p.predictedAt.getTime(), p.id] })
  }

  // RISK_CHANGE — chain = consecutive AUTOMATIC predictions in CLINICAL order
  // (per patient, over the patient's whole automatic history); an event is
  // emitted for a level change and belongs to the requested range when its
  // GENERATED time (current prediction's predictedAt) is in [from, to).
  for (const e of await riskChangeEvents(scope, from, to)) {
    keyed.push({ event: e.event, k: [e.at, e.at, e.recordId, TYPE_PRIORITY.RISK_CHANGE, e.at, e.event.id] })
  }

  return keyed.sort((a, b) => compareKeys(a.k, b.k)).map(x => x.event)
}

// NEW S3 — RISK_CHANGE events at GENERATED time.
async function riskChangeEvents(scope: Prisma.HealthRecordWhereInput, from?: Date, to?: Date): Promise<Array<{ event: RiskChangeTimelineEvent; at: number; recordId: string }>> {
  const inRange = (d: Date) => (!from || d >= from) && (!to || d < to)
  // Patients that have an automatic prediction GENERATED in range.
  const candidates = await prisma.prediction.findMany({
    where: {
      origin: 'AUTOMATIC_HEALTH_RECORD',
      healthRecord: { is: scope },
      ...(from || to ? { predictedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    },
    select: { patientId: true },
    distinct: ['patientId'],
  })
  if (candidates.length === 0) return []
  const chainRows = await prisma.prediction.findMany({
    where: { patientId: { in: candidates.map(c => c.patientId) }, origin: 'AUTOMATIC_HEALTH_RECORD', healthRecord: { is: scope } },
    select: { id: true, patientId: true, riskLevel: true, predictedAt: true, healthRecord: { select: RECORD_SELECT } },
  })
  const byPatient = new Map<string, typeof chainRows>()
  for (const p of chainRows) { if (!p.healthRecord) continue; const l = byPatient.get(p.patientId) ?? []; l.push(p); byPatient.set(p.patientId, l) }
  const out: Array<{ event: RiskChangeTimelineEvent; at: number; recordId: string }> = []
  for (const [patientId, seq] of byPatient) {
    const key = (p: (typeof seq)[number]): Keyed['k'] => {
      const r = p.healthRecord!
      return [effectiveClinicalTime(r).getTime(), r.recordedAt.getTime(), r.id, 0, p.predictedAt.getTime(), p.id]
    }
    seq.sort((a, b) => compareKeys(key(a), key(b)))
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1], cur = seq[i], r = cur.healthRecord!
      if (prev.riskLevel === cur.riskLevel || !inRange(cur.predictedAt)) continue
      out.push({
        at: cur.predictedAt.getTime(), recordId: r.id,
        event: {
          id: `risk-change:${cur.id}`, patientId, eventType: 'RISK_CHANGE', eventDate: cur.predictedAt.toISOString(),
          metadata: {
            fromLevel: prev.riskLevel, toLevel: cur.riskLevel, previousPredictionId: prev.id, currentPredictionId: cur.id,
            healthRecordId: r.id, clinicalTimeSource: isMeasured(r) ? 'CLINICIAN_ENTERED' : 'LEGACY_ENTRY_TIME',
            currentPredictedAt: cur.predictedAt.toISOString(),
            clinicalAt: effectiveClinicalTime(r).toISOString(),
            generatedAt: cur.predictedAt.toISOString(),
          },
          groupId: buildHealthRecordGroupId(patientId, r.id),
        },
      })
    }
  }
  return out
}
