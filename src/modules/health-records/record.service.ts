import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError, PatientInactiveError, InvalidMeasuredAtError } from '@/lib/errors'
import { calculateAgeAtClinicalTime } from '@/lib/age'
import { clinicalDayOf, utcDateToISODate } from '@/lib/timezone'
import { HealthRecordRepository } from './record.repository'
import { automaticPredictionWorker } from '@/modules/predictions/automatic/automaticPrediction.worker'
import { AlertService } from '@/modules/alerts/alert.service'
import { scheduleForecastOrchestration } from '@/modules/risk-forecasts/forecast.triggers'
import type { CreateHealthRecordRequestDtoType } from './record.dto'
import type { Server as IOServer } from 'socket.io'

const repo = new HealthRecordRepository()

// NEW S2A — allowed clock skew for a clinician-entered measuredAt (S1-FIX1 §4.8).
export const MEASURED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

export class HealthRecordService {
  constructor(private readonly io?: IOServer) {}

  // INT-20 — health_record_created. Real contract (new — no prior emission
  // existed for this module): room `patient:{patientId}`, same room as
  // subscribe_patient/unsubscribe_patient (INT-16/17) and prediction_completed
  // (INT-19). Minimal payload (ids + recordedAt), matching the lean style
  // already used by prediction_completed — NOT the full record, so the
  // frontend must refetch via the existing recordService rather than
  // fabricate missing fields client-side.
  async create(userId: string, dto: CreateHealthRecordRequestDtoType) {
    // Verify patient belongs to this doctor — now returns the owned Patient
    // (U3.2) so age derivation below reuses it instead of a second query.
    // assertPatientOwnership() below already excludes isHidden=true patients
    // (treated as not found) — see its own comment.
    const patient = await this.assertPatientOwnership(userId, dto.patientId)

    // Z8 §28 — a resolved-but-INACTIVE patient (isActive=false,
    // isHidden=false — otherwise assertPatientOwnership above would already
    // have thrown NotFoundError) may not receive new clinical activity.
    // Thrown BEFORE any HealthRecord insert and BEFORE the automatic
    // prediction kickoff below — no partial write, no
    // INFO_HEALTH_RECORD_CREATED, no AI call for an inactive patient.
    if (!patient.isActive) throw new PatientInactiveError()

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
    //
    // NEW S2A — REAL clinical time (A3/A4, S1-FIX1 §4). `recordedAt` keeps its
    // exact previous meaning (this request's entry instant, R's frozen time
    // axis); `measuredAt` is the clinician's REAL clinical instant, required
    // and already format-validated by CreateHealthRecordRequestDto. Bounds
    // are checked against the SAME single `now` used for recordedAt, before
    // any write (no HealthRecord, no Prediction, no Alert on failure):
    //   measuredAt ≤ now + 5 min           (back-dating is allowed)
    //   clinicalDay(measuredAt) ≥ birthDate (Guadalajara calendar)
    // `age` now describes the record's CLINICAL day, not its entry instant:
    // calendar age on the Guadalajara day of measuredAt. Legacy rows keep
    // their stored age; any client-sent `age` is still ignored.
    // clinicalTimeSource is server-assigned (the DTO rejects a client value).
    const now = new Date()
    const measuredAt = dto.measuredAt
    if (measuredAt.getTime() > now.getTime() + MEASURED_AT_MAX_FUTURE_SKEW_MS) {
      throw new InvalidMeasuredAtError('MEASURED_AT_IN_FUTURE')
    }
    if (clinicalDayOf(measuredAt) < utcDateToISODate(patient.birthDate)) {
      throw new InvalidMeasuredAtError('MEASURED_AT_BEFORE_BIRTH')
    }
    const age = calculateAgeAtClinicalTime(patient.birthDate, measuredAt)
    const { clinicalTimeSource: _rejectedByDto, ...clinical } = dto
    // NEW S4 — the HealthRecord and its durable automatic-Prediction
    // obligation are persisted ATOMICALLY (one transaction, no external I/O
    // inside it). The HTTP request succeeds once this COMMITs; AI scoring
    // happens afterwards in the durable worker, so an AI outage can never
    // lose the obligation nor fail the record creation.
    const record = await prisma.$transaction(async tx => {
      const created = await repo.create(userId, {
        ...clinical, age, recordedAt: now, measuredAt, clinicalTimeSource: 'CLINICIAN_ENTERED',
      }, tx)
      await tx.automaticPredictionTask.create({
        data: { healthRecordId: created.id, patientId: created.patientId, status: 'PENDING', attemptCount: 0, nextAttemptAt: now, createdAt: now },
      })
      return created
    })
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

    // Z5 — INFO_HEALTH_RECORD_CREATED. Created exactly once, ONLY after
    // repo.create() above already succeeded (a failed creation throws
    // before reaching this line). `patient` is the already-loaded owned
    // Patient from assertPatientOwnership() above — no extra query needed
    // for the message/patientName. Deliberately does NOT touch automatic-
    // prediction behavior below in any way — this Alert is about the
    // HealthRecord itself, not about whatever the AI service later decides
    // (a HIGH/MODERATE/ANOMALY prediction Alert, if any, is a fully
    // separate Alert created independently by PredictionService).
    // PRE-R2F — same duplication rule as patient.service.ts's information
    // Alerts: `patientName` already renders as this Alert's own title line
    // (Topbar/AlertsPage/AlertToast), so `message` no longer repeats the
    // name — the clinical meaning (a new record was registered) is fully
    // preserved without it.
    const alertSvc = new AlertService(this.io)
    await alertSvc.createInformationAlert({
      type:         'INFO_HEALTH_RECORD_CREATED',
      patientId:    record.patientId,
      doctorUserId: userId,
      patientName:  `${patient.firstName} ${patient.lastName}`,
      message:      'Se registró un nuevo registro clínico.',
    })

    // Q2 — automatic prediction. Deliberately NOT awaited: the HealthRecord
    // response must never depend on AI Service availability/latency (see
    // Q1 Decision 1). PredictionService owns 100% of the prediction logic
    // (AI call, persistence, alerting, prediction_completed emission) —
    // this only orchestrates the call, using the same `io` instance so the
    // eventual prediction_completed reaches the patient/doctor rooms. NEW
    // S2E-FIX4 — this is the ONLY Prediction creation path (no manual API). Errors are caught here so a failed/slow AI Service
    // can never surface as an unhandled rejection or affect this request.
    // NEW S2D — S forecast orchestration for the new REAL record, scheduled
    // independently of the automatic Prediction (which may fail, be
    // ineligible or be slow). Never awaited, never throws into this request;
    // a later verified Prediction re-triggers via ANCHOR_PREDICTION_PERSISTED.
    scheduleForecastOrchestration(record.patientId, 'HEALTH_RECORD_CREATED', this.io)

    // NEW S4 — the automatic Prediction is produced by the durable worker
    // (modules/predictions/automatic): this only asks for a prompt pass. The
    // obligation itself is already committed above, so a crash, restart or
    // AI outage from here on is recovered automatically (startup recovery,
    // periodic polling, lease expiry, bounded retry). NEW S4-FIX2: a record
    // whose clinical age the CURRENT model cannot score (MODEL_INELIGIBLE) ends
    // as a terminal BLOCKED/MODEL_INELIGIBLE task (never retried, no Prediction)
    // and emits prediction_unavailable once; technical failures →
    // prediction_failed are emitted by the worker with automatic retry.
    automaticPredictionWorker.kick()

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

  // Z8 §26 — the one shared ownership-resolution lookup for this module;
  // every caller (create/listByPatient/getOne/getLatest) inherits hidden-
  // exclusion from here automatically. A hidden patient behaves exactly
  // like a nonexistent one (NotFoundError), never a distinguishable
  // rejection — no "exists but hidden" leak. isActive is deliberately NOT
  // checked here (an INACTIVE_VISIBLE patient is still a real, resolvable,
  // owned patient for READ purposes — see getOne/listByPatient/getLatest,
  // which must keep working for it); the isActive gate lives only in
  // create() above, which is the one write path this module has.
  private async assertPatientOwnership(userId: string, patientId: string) {
    const doctor = await prisma.doctor.findUnique({ where: { userId } })
    if (!doctor) throw new ForbiddenError('Only doctors can access health records')

    const patient = await prisma.patient.findFirst({
      where: { id: patientId, doctorId: doctor.id, isHidden: false },
    })
    if (!patient) throw new NotFoundError('Patient')
    return patient
  }
}
