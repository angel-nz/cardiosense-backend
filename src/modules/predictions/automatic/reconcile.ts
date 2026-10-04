// NEW S4 — automatic-Prediction reconciliation (explicit command, never part
// of a Prisma migration). DRY-RUN by default.
//
// Candidates: CLINICIAN_ENTERED HealthRecords with ZERO linked Predictions of
// any origin — possibly interrupted automatic work from before S4 (the old
// fire-and-forget path lost the obligation on an AI failure). Records that
// already have any linked (historical or automatic) Prediction are never
// backfilled; LEGACY_ENTRY_TIME records are never touched; no origin is ever
// inferred or rewritten.
//   --apply           creates the missing durable task (PENDING) for every
//                     candidate WITHOUT a task (idempotent: ON CONFLICT DO
//                     NOTHING on the unique health_record_id).
//   --reopen-blocked  moves BLOCKED tasks whose last_error_code is one of the
//                     repairable data invariants (RECORD_NOT_FOUND,
//                     PREDICTION_MISMATCH) back to PENDING. NEW S4-FIX2:
//                     BLOCKED/MODEL_INELIGIBLE is a TERMINAL model-domain
//                     outcome (the record's age is outside the model range):
//                     it is listed informationally, counts as "has a task"
//                     (never withoutTask), and is never recreated or reopened.
// Intended for clone/test validation; on the normal database run the dry-run
// first and decide explicitly.
import { randomUUID } from 'crypto'
import { prisma } from '@/config/prisma'

export interface ReconcileCandidate {
  patientId:      string
  patientName:    string
  lifecycle:      'ACTIVE' | 'INACTIVE' | 'HIDDEN'
  healthRecordId: string
  clinicalAt:     string
  reason:         'NO_LINKED_PREDICTION'
  task:           null | { status: string; attemptCount: number; lastErrorCode: string | null }
}
export interface ReconcileReport {
  mode: 'DRY_RUN' | 'APPLY'
  candidates: ReconcileCandidate[]
  // BLOCKED by a genuine data invariant (the only ones --reopen-blocked may touch)
  blockedTasks: Array<{ taskId: string; healthRecordId: string; lastErrorCode: string | null }>
  // NEW S4-FIX2 — terminal BLOCKED/MODEL_INELIGIBLE (informational only; never reopened)
  modelIneligibleTasks: Array<{ taskId: string; healthRecordId: string }>
  created: number
  reopened: number
}

// Repairable invariant codes: the ONLY BLOCKED tasks --reopen-blocked may reopen.
export const REOPENABLE_BLOCKED_CODES = ['RECORD_NOT_FOUND', 'PREDICTION_MISMATCH'] as const

export async function runPredictionReconcile(opts: { apply: boolean; reopenBlocked?: boolean; patientIds?: string[] }): Promise<ReconcileReport> {
  const scope = opts.patientIds?.length ? opts.patientIds : null
  const rows = await prisma.$queryRaw<Array<{ patientId: string; first: string; last: string; isActive: boolean; isHidden: boolean; healthRecordId: string; clinicalAt: string; taskStatus: string | null; attemptCount: number | null; lastErrorCode: string | null }>>`
    SELECT h.patient_id AS "patientId", pa.first_name AS first, pa.last_name AS last, pa.is_active AS "isActive", pa.is_hidden AS "isHidden",
           h.id AS "healthRecordId", to_char(h.measured_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "clinicalAt",
           t.status::text AS "taskStatus", t.attempt_count AS "attemptCount", t.last_error_code AS "lastErrorCode"
    FROM health_records h
    JOIN pacientes pa ON pa.id = h.patient_id
    LEFT JOIN automatic_prediction_tasks t ON t.health_record_id = h.id
    WHERE h.clinical_time_source = 'CLINICIAN_ENTERED'
      AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.health_record_id = h.id)
      AND (${scope}::text[] IS NULL OR h.patient_id = ANY(${scope}::text[]))
    ORDER BY h.measured_at, h.id COLLATE "C"`
  const candidates: ReconcileCandidate[] = rows.map(r => ({
    patientId: r.patientId, patientName: `${r.first} ${r.last}`,
    lifecycle: r.isHidden ? 'HIDDEN' : r.isActive ? 'ACTIVE' : 'INACTIVE',
    healthRecordId: r.healthRecordId, clinicalAt: r.clinicalAt, reason: 'NO_LINKED_PREDICTION',
    task: r.taskStatus ? { status: r.taskStatus, attemptCount: r.attemptCount ?? 0, lastErrorCode: r.lastErrorCode } : null,
  }))
  const blocked = await prisma.automaticPredictionTask.findMany({
    where: { status: 'BLOCKED', OR: [{ lastErrorCode: null }, { lastErrorCode: { not: 'MODEL_INELIGIBLE' } }], ...(scope ? { patientId: { in: scope } } : {}) },
    select: { id: true, healthRecordId: true, lastErrorCode: true }, orderBy: { createdAt: 'asc' },
  })
  const ineligible = await prisma.automaticPredictionTask.findMany({
    where: { status: 'BLOCKED', lastErrorCode: 'MODEL_INELIGIBLE', ...(scope ? { patientId: { in: scope } } : {}) },
    select: { id: true, healthRecordId: true }, orderBy: { createdAt: 'asc' },
  })
  const reopenable = blocked.filter(b => (REOPENABLE_BLOCKED_CODES as readonly string[]).includes(b.lastErrorCode ?? ''))
  let created = 0, reopened = 0
  if (opts.apply) {
    const now = new Date().toISOString()
    for (const c of candidates.filter(c => c.task === null)) {
      created += await prisma.$executeRaw`
        INSERT INTO automatic_prediction_tasks (id, health_record_id, patient_id, status, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (${randomUUID()}, ${c.healthRecordId}, ${c.patientId}, 'PENDING', 0,
                (${now}::timestamptz AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC'))
        ON CONFLICT (health_record_id) DO NOTHING`
    }
    if (opts.reopenBlocked && reopenable.length) {
      reopened = await prisma.$executeRaw`
        UPDATE automatic_prediction_tasks
           SET status = 'PENDING', next_attempt_at = (${now}::timestamptz AT TIME ZONE 'UTC'), last_error_code = NULL,
               updated_at = (${now}::timestamptz AT TIME ZONE 'UTC')
         WHERE id = ANY(${reopenable.map(b => b.id)}::text[]) AND status = 'BLOCKED' AND last_error_code IN ('RECORD_NOT_FOUND', 'PREDICTION_MISMATCH')`
    }
  }
  return {
    mode: opts.apply ? 'APPLY' : 'DRY_RUN', candidates,
    blockedTasks: blocked.map(b => ({ taskId: b.id, healthRecordId: b.healthRecordId, lastErrorCode: b.lastErrorCode })),
    modelIneligibleTasks: ineligible.map(w => ({ taskId: w.id, healthRecordId: w.healthRecordId })),
    created, reopened,
  }
}
