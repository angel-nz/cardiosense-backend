// NEW S3 — clinical-time-first READ MODEL for doctor-facing surfaces.
//
// One canonical definition of the patient's clinically latest state:
//   effective clinical time = measured_at  (CLINICIAN_ENTERED)
//                           = recorded_at  (LEGACY_ENTRY_TIME fallback)
//   order DESC: effective → recorded_at → id (bytewise, COLLATE "C")
// Predictions are ordered by their SOURCE record's clinical time, then
// predicted_at, then id; an unlinked Prediction (no health record) falls back
// to its predicted_at.
//
// Read-path only. R-BPBC-3 uses measuredAt without legacy fallback; this
// doctor-facing read model keeps its own documented legacy fallback. The S bridge
// and write paths are otherwise untouched. All values are bound parameters ($queryRaw tagged
// templates); timestamps are returned as ISO text so both the native engine
// and the driver adapter yield identical strings.
import { Prisma } from '@prisma/client'
import { prisma } from '@/config/prisma'

// Effective clinical time of a HealthRecord row aliased `h`.
export const SQL_RECORD_EFFECTIVE = Prisma.sql`COALESCE(CASE WHEN h.clinical_time_source = 'CLINICIAN_ENTERED' THEN h.measured_at END, h.recorded_at)`
// Effective clinical time of a Prediction `p` LEFT JOIN its record `h`.
export const SQL_PREDICTION_EFFECTIVE = Prisma.sql`COALESCE(CASE WHEN h.clinical_time_source = 'CLINICIAN_ENTERED' THEN h.measured_at END, h.recorded_at, p.predicted_at)`
// Canonical Prediction clinical order (DESC).
export const SQL_PREDICTION_CLINICAL_ORDER_DESC = Prisma.sql`${SQL_PREDICTION_EFFECTIVE} DESC, h.recorded_at DESC NULLS LAST, h.id COLLATE "C" DESC NULLS LAST, p.predicted_at DESC, p.id COLLATE "C" DESC`

const ISO = (col: Prisma.Sql) => Prisma.sql`to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

export interface LatestClinicalRecord {
  patientId:          string
  healthRecordId:     string
  latestClinicalAt:   string                                   // ISO instant
  clinicalTimeSource: 'CLINICIAN_ENTERED' | 'LEGACY_ENTRY_TIME'
}

// The clinically latest HealthRecord of each patient.
export async function latestClinicalRecordsByPatient(patientIds: string[]): Promise<Map<string, LatestClinicalRecord>> {
  if (patientIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ patientId: string; healthRecordId: string; at: string; src: string }>>`
    SELECT DISTINCT ON (h.patient_id) h.patient_id AS "patientId", h.id AS "healthRecordId",
           ${ISO(SQL_RECORD_EFFECTIVE)} AS at,
           CASE WHEN h.clinical_time_source = 'CLINICIAN_ENTERED' AND h.measured_at IS NOT NULL THEN 'CLINICIAN_ENTERED' ELSE 'LEGACY_ENTRY_TIME' END AS src
    FROM health_records h
    WHERE h.patient_id = ANY(${patientIds}::text[])
    ORDER BY h.patient_id, ${SQL_RECORD_EFFECTIVE} DESC, h.recorded_at DESC, h.id COLLATE "C" DESC`
  return new Map(rows.map(r => [r.patientId, {
    patientId: r.patientId, healthRecordId: r.healthRecordId, latestClinicalAt: r.at,
    clinicalTimeSource: r.src === 'CLINICIAN_ENTERED' ? 'CLINICIAN_ENTERED' : 'LEGACY_ENTRY_TIME',
  }]))
}

// NEW S3-FIX1 — CURRENT observed risk, STRICT rule:
//   1. resolve each patient's EXACT clinically latest HealthRecord
//      (effective DESC, recorded_at DESC, id DESC — same order as above);
//   2. take only Predictions whose health_record_id = THAT record's id;
//   3. among them: predicted_at DESC, id DESC (historical records may carry
//      more than one Prediction; read-path determinism only).
// If the exact latest record has NO Prediction the patient has NO current
// observed risk — there is never a fallback to an older record, to the
// newest predicted_at, or to an unlinked Prediction (no linked record ⇒ it
// cannot be the latest clinical record's Prediction). One SQL statement,
// no N+1.
export async function currentPredictionIdsOfLatestClinicalRecord(patientIds: string[]): Promise<Map<string, string>> {
  if (patientIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ patientId: string; id: string }>>`
    WITH latest_record AS (
      SELECT DISTINCT ON (h.patient_id) h.patient_id, h.id
      FROM health_records h
      WHERE h.patient_id = ANY(${patientIds}::text[])
      ORDER BY h.patient_id, ${SQL_RECORD_EFFECTIVE} DESC, h.recorded_at DESC, h.id COLLATE "C" DESC
    )
    SELECT DISTINCT ON (lr.patient_id) lr.patient_id AS "patientId", p.id
    FROM latest_record lr
    JOIN predictions p ON p.health_record_id = lr.id AND p.patient_id = lr.patient_id
    ORDER BY lr.patient_id, p.predicted_at DESC, p.id COLLATE "C" DESC`
  return new Map(rows.map(r => [r.patientId, r.id]))
}

// NEW S3-FIX2 — exactly the PUBLIC fields the current-risk UI displays
// (gauge level/score, anomaly flag, calculation time, model version) plus the
// identities that prove the pairing. Never personalization internals,
// appliedLogit, sexUsed, provenance, fingerprints or bridge state.
const LATEST_PREDICTION_SELECT = { id: true, healthRecordId: true, riskLevel: true, riskScore: true, isAnomaly: true, predictedAt: true, modelVersion: true } as const
export type CurrentPredictionSummary = Prisma.PredictionGetPayload<{ select: typeof LATEST_PREDICTION_SELECT }>

// Current observed risk per patient (strict latest-record rule above).
// Patients whose exact latest record has no Prediction are ABSENT from the map.
export async function currentPredictionsOfLatestClinicalRecord(patientIds: string[]): Promise<Map<string, CurrentPredictionSummary>> {
  const idByPatient = await currentPredictionIdsOfLatestClinicalRecord(patientIds)
  if (idByPatient.size === 0) return new Map()
  const rows = await prisma.prediction.findMany({ where: { id: { in: [...idByPatient.values()] } }, select: LATEST_PREDICTION_SELECT })
  const byId = new Map(rows.map(r => [r.id, r]))
  const out = new Map<string, CurrentPredictionSummary>()
  for (const [patientId, id] of idByPatient) { const r = byId.get(id); if (r) out.set(patientId, r) }
  return out
}

// NEW S4 — PUBLIC workflow state of the durable automatic-Prediction task of
// a patient's exact latest clinical record (no error bodies, no worker ids,
// no infrastructure detail). PROCESSING with an expired lease is reported as
// PENDING (awaiting automatic recovery). NEW S4-FIX2: a task terminally
// BLOCKED because the record's age is outside the model range is reported as
// MODEL_INELIGIBLE (terminal: no prediction will be generated for this
// record, no retry). COMPLETED ⇒ currentPrediction exists; any other BLOCKED
// (data invariant) ⇒ null.
export interface CurrentPredictionTaskView {
  status:        'PENDING' | 'PROCESSING' | 'RETRY_WAIT' | 'MODEL_INELIGIBLE'
  attemptCount:  number
  lastAttemptAt: string | null
}
export async function activePredictionTasksByRecord(recordIds: string[]): Promise<Map<string, CurrentPredictionTaskView>> {
  if (recordIds.length === 0) return new Map()
  const rows = await prisma.automaticPredictionTask.findMany({
    where: {
      healthRecordId: { in: recordIds },
      OR: [
        { status: { in: ['PENDING', 'PROCESSING', 'RETRY_WAIT'] } },
        { status: 'BLOCKED', lastErrorCode: 'MODEL_INELIGIBLE' },
      ],
    },
    select: { healthRecordId: true, status: true, attemptCount: true, lastAttemptAt: true, leaseUntil: true },
  })
  const now = Date.now()
  return new Map(rows.map(t => [t.healthRecordId, {
    status: (t.status === 'BLOCKED' ? 'MODEL_INELIGIBLE'
      : t.status === 'PROCESSING' && (!t.leaseUntil || t.leaseUntil.getTime() < now) ? 'PENDING'
      : t.status) as CurrentPredictionTaskView['status'],
    attemptCount: t.attemptCount,
    lastAttemptAt: t.lastAttemptAt ? t.lastAttemptAt.toISOString() : null,
  }]))
}

// Patient ids ordered by latest clinical time DESC; patients without any
// clinical record last (then created_at DESC, id) — deterministic.
export async function orderPatientIdsByLatestClinical(patientIds: string[]): Promise<string[]> {
  if (patientIds.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT pa.id
    FROM patients pa
    LEFT JOIN LATERAL (
      SELECT max(${SQL_RECORD_EFFECTIVE}) AS m FROM health_records h WHERE h.patient_id = pa.id
    ) l ON true
    WHERE pa.id = ANY(${patientIds}::text[])
    ORDER BY l.m DESC NULLS LAST, pa.created_at DESC, pa.id COLLATE "C" ASC`
  return rows.map(r => r.id)
}

// Decorates patient payloads from ONE canonical read model:
//   latestClinicalAt / latestClinicalTimeSource / latestClinicalRecordId
//     = the patient's EXACT clinically latest HealthRecord;
//   currentPrediction (NEW S3-FIX2, canonical)
//     = the newest Prediction (predictedAt DESC, id DESC) attached to THAT
//       record, or null (no current observed risk). Independent of any
//       Prediction-history page / window.
//   predictions (kept for backward compatibility only) = currentPrediction
//     ? [currentPrediction] : [] — same object, never a history.
// Invariant: currentPrediction === null OR
//   currentPrediction.healthRecordId === latestClinicalRecordId (S3-FIX1).
// `updatedAt` is kept as a technical audit field only.
export async function withClinicalLatest<T extends { id: string }>(patients: T[]): Promise<Array<Omit<T, 'predictions'> & {
  latestClinicalAt: string | null
  latestClinicalTimeSource: 'CLINICIAN_ENTERED' | 'LEGACY_ENTRY_TIME' | null
  latestClinicalRecordId: string | null
  currentPrediction: CurrentPredictionSummary | null
  currentPredictionTask: CurrentPredictionTaskView | null
  predictions: CurrentPredictionSummary[]
}>> {
  const ids = patients.map(p => p.id)
  const [records, preds] = await Promise.all([latestClinicalRecordsByPatient(ids), currentPredictionsOfLatestClinicalRecord(ids)])
  // NEW S4 — active durable task of the EXACT latest record, only while that
  // record has no Prediction yet (one batched query, no N+1).
  const pendingRecordIds = [...records.values()].filter(r => !preds.has(r.patientId)).map(r => r.healthRecordId)
  const tasks = await activePredictionTasksByRecord(pendingRecordIds)
  return patients.map(p => {
    const { predictions: _old, ...rest } = p as T & { predictions?: unknown }
    void _old
    const r = records.get(p.id)
    // Belt and braces: both queries are separate statements; a record
    // inserted between them must never pair a Prediction with a different
    // latest record. Enforce the invariant here.
    const candidate = preds.get(p.id)
    const pr = candidate && r && candidate.healthRecordId === r.healthRecordId ? candidate : undefined
    return {
      ...(rest as Omit<T, 'predictions'>),
      latestClinicalAt: r?.latestClinicalAt ?? null,
      latestClinicalTimeSource: r?.clinicalTimeSource ?? null,
      latestClinicalRecordId: r?.healthRecordId ?? null,
      currentPrediction: pr ?? null,
      currentPredictionTask: !pr && r ? tasks.get(r.healthRecordId) ?? null : null,
      predictions: pr ? [pr] : [],
    }
  })
}

// ─── Prediction clinical-order read model (doctor-facing lists) ─────────
export interface ClinicalPredictionQuery {
  patientIds: string[]
  riskLevel?: string
  from?: Date          // [from, to) on the Prediction's EFFECTIVE clinical time
  to?: Date
}

// ALL matching Prediction ids in canonical clinical order DESC. Ordering
// happens in SQL before any offset/limit; callers slice pages and resolve
// targetId positions from this one ordered list.
export async function orderedClinicalPredictionIds(q: ClinicalPredictionQuery): Promise<string[]> {
  if (q.patientIds.length === 0) return []
  const fromIso = q.from ? q.from.toISOString() : null
  const toIso = q.to ? q.to.toISOString() : null
  const risk = q.riskLevel ?? null
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT p.id
    FROM predictions p LEFT JOIN health_records h ON h.id = p.health_record_id
    WHERE p.patient_id = ANY(${q.patientIds}::text[])
      AND (${risk}::text IS NULL OR p.risk_level::text = ${risk}::text)
      AND (${fromIso}::text IS NULL OR ${SQL_PREDICTION_EFFECTIVE} >= (${fromIso}::timestamptz AT TIME ZONE 'UTC'))
      AND (${toIso}::text IS NULL OR ${SQL_PREDICTION_EFFECTIVE} < (${toIso}::timestamptz AT TIME ZONE 'UTC'))
    ORDER BY ${SQL_PREDICTION_CLINICAL_ORDER_DESC}`
  return rows.map(r => r.id)
}

// Predictions whose source record's EFFECTIVE clinical instant lies in
// [start, end) — dashboard activity counts. Returns the effective instants.
export async function predictionClinicalInstantsInRange(doctorId: string, start: Date, end: Date): Promise<Date[]> {
  const rows = await prisma.$queryRaw<Array<{ at: string }>>`
    SELECT ${ISO(SQL_PREDICTION_EFFECTIVE)} AS at
    FROM predictions p
    JOIN patients pa ON pa.id = p.patient_id
    LEFT JOIN health_records h ON h.id = p.health_record_id
    WHERE pa.doctor_id = ${doctorId} AND pa.is_hidden = false
      AND ${SQL_PREDICTION_EFFECTIVE} >= (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND ${SQL_PREDICTION_EFFECTIVE} <  (${end.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
  return rows.map(r => new Date(r.at))
}
