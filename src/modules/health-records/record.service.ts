import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError, ModelIneligibleError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { calculateAge } from '@/lib/age'
import { HealthRecordRepository } from './record.repository'
import { PredictionService } from '@/modules/predictions/prediction.service'
import type { CreateRecordDtoType } from './record.dto'
import type { Server as IOServer } from 'socket.io'

const repo = new HealthRecordRepository()

export class HealthRecordService {
  constructor(private readonly io?: IOServer) {}

  // INT-20 — health_record_created. Real contract (new — no prior emission
  // existed for this module): room `patient:{patientId}`, same room as
  // subscribe_patient/unsubscribe_patient (INT-16/17) and prediction_completed
  // (INT-19). Minimal payload (ids + recordedAt), matching the lean style
  // already used by prediction_completed — NOT the full record, so the
  // frontend must refetch via the existing recordService rather than
  // fabricate missing fields client-side.
  async create(userId: string, dto: CreateRecordDtoType) {
    // Verify patient belongs to this doctor — now returns the owned Patient
    // (U3.2) so age derivation below reuses it instead of a second query.
    const patient = await this.assertPatientOwnership(userId, dto.patientId)
    // U3.2 / V-AGE-FIX-2 §3 — age is backend-authoritative, derived from
    // Paciente.birthDate at persistence time (this record's own observation
    // moment). `recordedAt` was previously left to Prisma's `@default(now())`
    // at INSERT time, a SEPARATE `now()` evaluation from the one used here
    // for `age` — two independent instants that could (in principle, right
    // around a UTC calendar-day boundary) disagree on what "today" is,
    // letting age and recordedAt describe two different observation dates
    // for the same record. `recordedAt` is now derived from this SAME `now`
    // instance and passed through explicitly, so age and recordedAt always
    // describe one canonical instant. Any `dto.age` the client might still
    // send (now optional, kept only for legacy callers — see record.dto.ts)
    // is always overwritten here, never trusted.
    const now = new Date()
    const age = calculateAge(patient.birthDate, now)
    const record = await repo.create(userId, { ...dto, age, recordedAt: now })
    this.io?.to(`patient:${record.patientId}`).emit('health_record_created', {
      recordId:   record.id,
      patientId:  record.patientId,
      recordedAt: record.recordedAt,
    })
    // O4.2 — dashboard_activity_changed. Invalidation-only signal for
    // Dashboard Calendar (user:{userId} — the same room new_alert already
    // uses, auto-joined on connect, no subscribe_patient needed). Emitted
    // here unconditionally, before the automatic prediction below even
    // starts, so this fires whether or not AI inference later succeeds —
    // covering exactly the Q2-FIX gap O4.1 identified (HealthRecord
    // persisted + AI failure + no Prediction + no Alert must still reach
    // the Dashboard). Payload carries no timeline/metadata — receivers
    // must do a canonical refetch, never build a CLINICAL_RECORD from this.
    this.io?.to(`user:${userId}`).emit('dashboard_activity_changed', {
      patientId:  record.patientId,
      eventDate:  record.recordedAt,
    })

    // Q2 — automatic prediction. Deliberately NOT awaited: the HealthRecord
    // response must never depend on AI Service availability/latency (see
    // Q1 Decision 1). PredictionService owns 100% of the prediction logic
    // (AI call, persistence, alerting, prediction_completed emission) —
    // this only orchestrates the call, using the same `io` instance so the
    // eventual prediction_completed reaches the same rooms as any manual
    // prediction would. Errors are caught here so a failed/slow AI Service
    // can never surface as an unhandled rejection or affect this request.
    new PredictionService(this.io)
      .predict(userId, { patientId: record.patientId, healthRecordId: record.id })
      .catch(err => {
        // U8.6C — MODEL_INELIGIBLE is an expected domain outcome (the
        // current model does not support this record's age), never a
        // technical failure. No Prediction/Alert/prediction_completed is
        // produced for it (by design, inside predict() itself — nothing
        // changes here about that). Logged at `info`, not `error` — this
        // is not something operationally wrong. The dedicated
        // `prediction_unavailable` event lets a doctor currently viewing
        // this patient learn the outcome without polling; `userId` here is
        // the SAME authenticated doctor already used for
        // `dashboard_activity_changed` above — never derived from anything
        // client-supplied at this point, so this can only ever reach the
        // room of the doctor who created this exact record.
        if (err instanceof ModelIneligibleError) {
          logger.info('Automatic prediction skipped: model ineligible', {
            recordId: record.id,
            patientId: record.patientId,
            age: record.age,
            modelVersion: err.modelVersion,
          })
          this.io?.to(`user:${userId}`).emit('prediction_unavailable', {
            patientId: record.patientId,
            healthRecordId: record.id,
            reason: 'MODEL_INELIGIBLE',
            modelVersion: err.modelVersion,
            eligibleAgeRange: err.eligibleAgeRange,
          })
          return
        }
        // Technical/unexpected failures (AI unreachable, AI 500/502, etc.)
        // keep the original error-level log — nothing here changes for
        // that case, and no prediction_unavailable is emitted for it
        // (that event means "the record is fine, the model just doesn't
        // support it" — never "something went wrong").
        logger.error('Automatic prediction failed for new health record', {
          recordId: record.id,
          patientId: record.patientId,
          err: err instanceof Error ? err.message : err,
        })
      })

    return record
  }

  async listByPatient(userId: string, patientId: string, limit: number) {
    await this.assertPatientOwnership(userId, patientId)
    return repo.findByPatient(patientId, limit)
  }

  async getOne(userId: string, recordId: string) {
    const record = await repo.findById(recordId)
    if (!record) throw new NotFoundError('Health record')
    await this.assertPatientOwnership(userId, record.patientId)
    return record
  }

  // U3.2 — exposes the previously-unused getLatest/findLatestByPatient
  // capability via a new route (patient.timeline-style reuse — no
  // duplicated repository logic). Ownership was missing before (this
  // method was dead code, never reached by any controller) — added here
  // using the exact same pattern as every other method in this class,
  // never trusting patientId alone. Returns `null` when the patient has no
  // prior HealthRecord — that is a normal state, not an error.
  async getLatest(userId: string, patientId: string) {
    await this.assertPatientOwnership(userId, patientId)
    return repo.findLatestByPatient(patientId)
  }

  private async assertPatientOwnership(userId: string, patientId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access health records')

    const patient = await prisma.paciente.findFirst({
      where: { id: patientId, medicoId: medico.id },
    })
    if (!patient) throw new NotFoundError('Patient')
    return patient
  }
}
