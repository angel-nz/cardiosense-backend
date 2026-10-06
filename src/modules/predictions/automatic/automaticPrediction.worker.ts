// NEW S4 — durable automatic-Prediction worker / reconciler.
//
// Contract (S4 §2–§16):
//   • every newly accepted HealthRecord is persisted ATOMICALLY with one
//     AutomaticPredictionTask (PENDING) — record.service.ts;
//   • after COMMIT this worker claims due tasks with
//       SELECT … FOR UPDATE SKIP LOCKED   +   a bounded processing lease,
//     so any number of backend processes can run it concurrently; correctness
//     never relies on in-memory locks;
//   • before any AI call it checks whether the record's ONE automatic
//     Prediction already exists (crash after Prediction COMMIT, lost lease,
//     concurrent worker). NEW S4-FIX1: finding it is NOT completion — the
//     canonical post-COMMIT finalizer (PredictionService
//     .finalizeExistingAutomaticPrediction: Alert notification,
//     prediction_completed, dashboard signal, S ANCHOR_PREDICTION_PERSISTED)
//     runs first; the task is COMPLETED only AFTER it succeeds. No AI call,
//     no new Prediction / Alert / bridge row. Post-COMMIT signals are
//     AT-LEAST-ONCE (a crash may repeat them; clients refetch idempotently);
//     the clinical DB rows stay exactly-once;
//   • otherwise it calls the canonical core PredictionService
//     .scoreAndPersistAutomatic (R, Alert, bridge, S2C-FIX1 post-COMMIT
//     verification, then the same finalizer); the task is COMPLETED only
//     AFTER both. A finalizer failure after the Prediction committed
//     (AutomaticFinalizationError) → RETRY_WAIT / FINALIZATION_FAILED; the
//     retry finds the Prediction and re-runs ONLY the finalizer (no AI);
//   • the partial UNIQUE index predictions_one_automatic_per_health_record is
//     the database-level guarantee: a racing second insert rolls back and is
//     reconciled as "already exists";
//   • recoverable failures (AI down / timeout / 5xx / 503 / 422 / malformed,
//     DB failure, commit-verification failure, finalization failure,
//     unexpected backend error) → RETRY_WAIT with deterministic backoff
//     5 s · 2^(n−1), capped at 300 s, retried indefinitely;
//   • NEW S4-FIX2 — MODEL_INELIGIBLE (the record's clinical age is outside the
//     CURRENT model's supported range) is a TERMINAL model-domain outcome:
//     the HealthRecord stays, no Prediction is fabricated, the task becomes
//     BLOCKED / MODEL_INELIGIBLE with next_attempt_at = NULL, and it is never
//     claimed, polled, recovered at startup or rescored again (a record's age
//     is historical clinical data; neither time nor a later model release
//     resurrects it). A NEW HealthRecord gets its own task. The legacy
//     WAITING_MODEL_SUPPORT state is deprecated and unreachable;
//   • BLOCKED therefore means: MODEL_INELIGIBLE (terminal business outcome),
//     or a genuine data invariant (RECORD_NOT_FOUND, PREDICTION_MISMATCH).
//     Only the invariants can be reopened (prediction:reconcile
//     --reopen-blocked); MODEL_INELIGIBLE never is.
//   • a crashed worker's PROCESSING row is reclaimed after `lease_until`.
//   • already-accepted records complete even if the patient is later
//     deactivated or hidden (S4 §14) — the HTTP-era active/hidden gate is not
//     re-applied here; visibility rules still apply to UI reads.
// Errors are persisted only as short sanitized categories (no stack traces,
// payloads, keys or URLs).
import { randomUUID } from 'crypto'
import type { Server as IOServer } from 'socket.io'
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'
import {
  AIInputRejectedError, AIServiceError, ModelIneligibleError, ServiceUnavailableError, TransactionCommitVerificationError,
} from '@/lib/errors'
import {
  AutomaticFinalizationError, AutomaticPredictionAlreadyExistsError, AutomaticPredictionMismatchError, PredictionService,
} from '../prediction.service'

// ── policy constants (deterministic, documented) ─────────────────────────
// Lease: > AI client timeout (30 s) + capability probe + evidence + DB, with
// margin. A PROCESSING row whose lease expired is reclaimable by any worker.
export const AUTO_TASK_LEASE_MS = 120_000
export const AUTO_TASK_POLL_MS = 5_000
export const AUTO_TASK_BATCH = 5
export const AUTO_TASK_BACKOFF_BASE_MS = 5_000
export const AUTO_TASK_BACKOFF_MAX_MS = 300_000
// attempt n (1-based, the attempt that just failed): 5,10,20,40,80,160,300,300,… s
export function autoTaskBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(AUTO_TASK_BACKOFF_MAX_MS, AUTO_TASK_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 16))
}

export type AutoTaskErrorCode =
  | 'AI_UNAVAILABLE' | 'AI_INPUT_REJECTED' | 'AI_FAILURE' | 'COMMIT_NOT_VERIFIED' | 'FINALIZATION_FAILED' | 'BACKEND_ERROR'
  | 'MODEL_INELIGIBLE' | 'RECORD_NOT_FOUND' | 'PREDICTION_MISMATCH'

// kind: RETRY = technical, backoff; BLOCK = terminal (model-domain
// ineligibility or a genuine invariant), never claimed again.
export type AutoTaskErrorKind = 'RETRY' | 'BLOCK'
export function classifyAutoTaskError(err: unknown): { code: AutoTaskErrorCode; kind: AutoTaskErrorKind } {
  if (err instanceof ModelIneligibleError) return { code: 'MODEL_INELIGIBLE', kind: 'BLOCK' }
  if (err instanceof AutomaticPredictionMismatchError) return { code: 'PREDICTION_MISMATCH', kind: 'BLOCK' }
  if (err instanceof AutomaticFinalizationError) return { code: 'FINALIZATION_FAILED', kind: 'RETRY' }
  if (err instanceof ServiceUnavailableError) return { code: 'AI_UNAVAILABLE', kind: 'RETRY' }
  if (err instanceof AIInputRejectedError) return { code: 'AI_INPUT_REJECTED', kind: 'RETRY' }
  if (err instanceof AIServiceError) return { code: 'AI_FAILURE', kind: 'RETRY' }
  if (err instanceof TransactionCommitVerificationError) return { code: 'COMMIT_NOT_VERIFIED', kind: 'RETRY' }
  return { code: 'BACKEND_ERROR', kind: 'RETRY' }
}

interface ClaimedTask { id: string; healthRecordId: string; patientId: string; attemptCount: number }
export type AutoTaskOutcome = 'COMPLETED' | 'RECONCILED_EXISTING' | 'RETRY_WAIT' | 'BLOCKED' | 'LEASE_LOST'

const ts = (d: Date) => d.toISOString()

export class AutomaticPredictionWorker {
  readonly workerId: string
  private io: IOServer | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private ticking: Promise<void> | null = null
  private again = false

  constructor(workerId = `w-${randomUUID()}`) { this.workerId = workerId }

  // Startup recovery + periodic polling. Immediately discovers due PENDING,
  // RETRY_WAIT and lease-expired PROCESSING tasks (no user visit, no frontend
  // connection, no manual command needed).
  start(io?: IOServer): void {
    if (this.running) return
    this.io = io
    this.running = true
    this.timer = setInterval(() => this.kick(), AUTO_TASK_POLL_MS)
    this.timer.unref?.()
    this.kick()
    logger.info('Automatic-Prediction worker started', { workerId: this.workerId, pollMs: AUTO_TASK_POLL_MS, leaseMs: AUTO_TASK_LEASE_MS })
  }

  // Clean shutdown: no new ticks; waits for the tick in flight. A task left
  // PROCESSING by an interrupted tick is reclaimed after its lease.
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.ticking) await this.ticking.catch(() => undefined)
  }

  // Ask for a prompt pass (e.g. right after a HealthRecord commit). Coalesced.
  kick(): void {
    if (!this.running) return
    if (this.ticking) { this.again = true; return }
    this.ticking = this.drain().finally(() => {
      this.ticking = null
      if (this.again && this.running) { this.again = false; this.kick() }
    })
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const n = await this.runOnce()
        if (n === 0 || !this.running) return
      }
    } catch (err) {
      logger.warn('Automatic-Prediction worker pass failed — will retry on next poll', { errorType: err instanceof Error ? err.name : typeof err })
    }
  }

  // One claim + process pass. Returns the number of tasks claimed.
  async runOnce(limit = AUTO_TASK_BATCH): Promise<number> {
    const claimed = await this.claim(limit)
    for (const t of claimed) await this.process(t)
    return claimed.length
  }

  async claim(limit = AUTO_TASK_BATCH): Promise<ClaimedTask[]> {
    const now = new Date()
    const leaseUntil = new Date(now.getTime() + AUTO_TASK_LEASE_MS)
    return prisma.$transaction(async tx => {
      const due = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM automatic_prediction_tasks
        WHERE (status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= (${ts(now)}::timestamptz AT TIME ZONE 'UTC'))
           OR (status = 'PROCESSING' AND lease_until < (${ts(now)}::timestamptz AT TIME ZONE 'UTC'))
        ORDER BY next_attempt_at, id COLLATE "C"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`
      if (due.length === 0) return []
      return tx.$queryRaw<ClaimedTask[]>`
        UPDATE automatic_prediction_tasks
           SET status = 'PROCESSING',
               lease_until = (${ts(leaseUntil)}::timestamptz AT TIME ZONE 'UTC'),
               lease_owner = ${this.workerId},
               attempt_count = attempt_count + 1,
               last_attempt_at = (${ts(now)}::timestamptz AT TIME ZONE 'UTC'),
               updated_at = (${ts(now)}::timestamptz AT TIME ZONE 'UTC')
         WHERE id = ANY(${due.map(d => d.id)}::text[])
        RETURNING id, health_record_id AS "healthRecordId", patient_id AS "patientId", attempt_count AS "attemptCount"`
    })
  }

  async process(task: ClaimedTask): Promise<AutoTaskOutcome> {
    const record = await prisma.healthRecord.findUnique({ where: { id: task.healthRecordId }, select: { id: true, patientId: true } })
    const patient = await prisma.patient.findUnique({ where: { id: task.patientId }, include: { doctor: { select: { userId: true } } } })

    // 1. Exactly-once convergence of the BUSINESS rows: the record's AUTO
    //    Prediction may already exist (crash after COMMIT, lost lease, racing
    //    worker, reconciliation). It is never rescored. NEW S4-FIX1: it is
    //    also not yet "completion" — the canonical post-COMMIT finalizer runs
    //    first (at-least-once safe), the task completes only after it.
    const existing = await prisma.prediction.findFirst({
      where: { healthRecordId: task.healthRecordId, origin: 'AUTOMATIC_HEALTH_RECORD' }, select: { id: true },
    })
    if (existing) {
      if (!record || !patient || record.patientId !== patient.id) return this.block(task, 'RECORD_NOT_FOUND', null)
      return this.finalizeExisting(task, existing.id, patient)
    }

    if (!record || !patient || record.patientId !== patient.id) return this.block(task, 'RECORD_NOT_FOUND', null)
    const fullRecord = await prisma.healthRecord.findUnique({ where: { id: task.healthRecordId } })
    if (!fullRecord) return this.block(task, 'RECORD_NOT_FOUND', null)

    try {
      const prediction = await new PredictionService(this.io).scoreAndPersistAutomatic({ patient, record: fullRecord, doctorUserId: patient.doctor.userId })
      // Reached only after the S2C-FIX1 post-COMMIT verification AND the
      // post-COMMIT finalizer succeeded.
      return (await this.complete(task, prediction.id)) ? 'COMPLETED' : 'LEASE_LOST'
    } catch (err) {
      if (err instanceof AutomaticPredictionAlreadyExistsError) {
        const winner = await prisma.prediction.findFirst({
          where: { healthRecordId: task.healthRecordId, origin: 'AUTOMATIC_HEALTH_RECORD' }, select: { id: true },
        })
        if (winner) return this.finalizeExisting(task, winner.id, patient)
      }
      return this.handleFailure(task, err, patient.doctor.userId)
    }
  }

  private async finalizeExisting(
    task: ClaimedTask, predictionId: string,
    patient: { id: string; firstName: string; lastName: string; doctor: { userId: string } },
  ): Promise<AutoTaskOutcome> {
    try {
      await new PredictionService(this.io).finalizeExistingAutomaticPrediction({
        patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
        healthRecordId: task.healthRecordId, predictionId, doctorUserId: patient.doctor.userId,
      })
    } catch (err) {
      // A finalizer failure never calls the AI again: the retry lands here again.
      if (err instanceof AutomaticPredictionMismatchError) return this.handleFailure(task, err, patient.doctor.userId)
      return this.handleFailure(task, new AutomaticFinalizationError(predictionId, err instanceof Error ? err.name : typeof err), patient.doctor.userId)
    }
    return (await this.complete(task, predictionId)) ? 'RECONCILED_EXISTING' : 'LEASE_LOST'
  }

  private async handleFailure(task: ClaimedTask, err: unknown, doctorUserId: string): Promise<AutoTaskOutcome> {
    const { code, kind } = classifyAutoTaskError(err)
    if (kind === 'BLOCK') return this.block(task, code, err, doctorUserId)
    return this.retry(task, code, doctorUserId)
  }

  // ── owner-guarded state transitions ───────────────────────────────────
  private async complete(task: ClaimedTask, predictionId: string): Promise<boolean> {
    const now = new Date()
    const n = await prisma.$executeRaw`
      UPDATE automatic_prediction_tasks
         SET status = 'COMPLETED', prediction_id = ${predictionId},
             completed_at = (${ts(now)}::timestamptz AT TIME ZONE 'UTC'),
             lease_until = NULL, lease_owner = NULL, last_error_code = NULL,
             updated_at = (${ts(now)}::timestamptz AT TIME ZONE 'UTC')
       WHERE id = ${task.id} AND status = 'PROCESSING' AND lease_owner = ${this.workerId}`
    return n === 1
  }

  private async retry(task: ClaimedTask, code: AutoTaskErrorCode, doctorUserId: string): Promise<AutoTaskOutcome> {
    const now = new Date()
    const next = new Date(now.getTime() + autoTaskBackoffMs(task.attemptCount))
    const n = await prisma.$executeRaw`
      UPDATE automatic_prediction_tasks
         SET status = 'RETRY_WAIT', next_attempt_at = (${ts(next)}::timestamptz AT TIME ZONE 'UTC'),
             lease_until = NULL, lease_owner = NULL, last_error_code = ${code},
             updated_at = (${ts(now)}::timestamptz AT TIME ZONE 'UTC')
       WHERE id = ${task.id} AND status = 'PROCESSING' AND lease_owner = ${this.workerId}`
    if (n !== 1) return 'LEASE_LOST'
    logger.warn('Automatic prediction attempt failed — retry scheduled', {
      taskId: task.id, healthRecordId: task.healthRecordId, attempt: task.attemptCount, code, nextAttemptInMs: next.getTime() - now.getTime(),
    })
    // Existing W4.2 contract, now "attempt failed, retrying automatically":
    // lets an open PatientDetail refetch its pending/retrying state.
    const reason = code === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE' : code === 'AI_INPUT_REJECTED' ? 'AI_INPUT_REJECTED' : code === 'AI_FAILURE' ? 'AI_FAILURE' : null
    if (reason) {
      try { this.io?.to(`user:${doctorUserId}`).emit('prediction_failed', { patientId: task.patientId, healthRecordId: task.healthRecordId, reason }) } catch { /* best effort */ }
    }
    return 'RETRY_WAIT'
  }

  // Terminal outcomes: MODEL_INELIGIBLE (NEW S4-FIX2, business/model-domain)
  // and genuine data invariants. next_attempt_at = NULL: a BLOCKED task is
  // never claimable, whatever the clock or the model version says.
  private async block(task: ClaimedTask, code: AutoTaskErrorCode, err: unknown, doctorUserId?: string): Promise<AutoTaskOutcome> {
    const now = new Date()
    const n = await prisma.$executeRaw`
      UPDATE automatic_prediction_tasks
         SET status = 'BLOCKED', next_attempt_at = NULL, lease_until = NULL, lease_owner = NULL, last_error_code = ${code},
             updated_at = (${ts(now)}::timestamptz AT TIME ZONE 'UTC')
       WHERE id = ${task.id} AND status = 'PROCESSING' AND lease_owner = ${this.workerId}`
    if (n !== 1) return 'LEASE_LOST'
    if (code === 'MODEL_INELIGIBLE') {
      const e = err instanceof ModelIneligibleError ? err : null
      logger.info('Automatic prediction not generated — age outside the model range (terminal)', {
        taskId: task.id, healthRecordId: task.healthRecordId, modelVersion: e?.modelVersion,
      })
      // Emitted ONCE, on the transition (never re-emitted: the task is not claimable again).
      if (doctorUserId) {
        try {
          this.io?.to(`user:${doctorUserId}`).emit('prediction_unavailable', {
            patientId: task.patientId, healthRecordId: task.healthRecordId, reason: 'MODEL_INELIGIBLE',
            modelVersion: e?.modelVersion, eligibleAgeRange: e?.eligibleAgeRange,
          })
        } catch { /* best effort */ }
      }
    } else {
      logger.error('Automatic prediction task BLOCKED (data invariant)', { taskId: task.id, healthRecordId: task.healthRecordId, code })
    }
    return 'BLOCKED'
  }
}

// The process-wide worker (started in index.ts after Socket.IO setup).
// NEW S4 test-only switch: AUTO_PREDICTION_WORKER_DISABLED=1 keeps it from
// auto-starting so a harness can drive runOnce() deterministically. Default
// (unset) = enabled.
export const automaticPredictionWorker = new AutomaticPredictionWorker()
export const isAutomaticPredictionWorkerDisabled = () => process.env.AUTO_PREDICTION_WORKER_DISABLED === '1'
