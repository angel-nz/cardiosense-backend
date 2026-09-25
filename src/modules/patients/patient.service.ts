import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError, ValidationError } from '@/lib/errors'
import { isCanonicalPhone } from '@/lib/phone'
import { PatientRepository } from './patient.repository'
import { paginate } from '@/types'
import { PHONE_MESSAGE } from './patient.dto'
import type { CreatePatientDtoType, UpdatePatientDtoType, PatientQueryDtoType, HistoryQueryDtoType } from './patient.dto'
import type { Server as IOServer } from 'socket.io'
import { HealthRecordRepository } from '@/modules/health-records/record.repository'
import { PredictionRepository } from '@/modules/predictions/prediction.repository'
import { AlertRepository } from '@/modules/alerts/alert.repository'
import {
  toClinicalRecordEvent, toPredictionEvent, toAlertEvent,
  deriveRiskChanges, sortTimelineEvents,
  type PatientTimelineEvent,
} from './patient.timeline'

const repo = new PatientRepository()
const recordRepo = new HealthRecordRepository()
const predictionRepo = new PredictionRepository()
const alertRepo = new AlertRepository()

export class PatientService {
  constructor(private readonly io?: IOServer) {}

  async list(userId: string, query: PatientQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const { data, total } = await repo.findAll(medico.id, {
      page:   query.page,
      limit:  query.limit,
      search: query.search,
    })
    return paginate(data, total, query.page, query.limit)
  }

  async getOne(userId: string, patientId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    const patient = await repo.findById(patientId, medico.id)
    if (!patient) throw new NotFoundError('Patient')
    return patient
  }

  // U2.2 — patient_created. Invalidation-only signal, user:{userId} room
  // (same room dashboard_activity_changed/new_alert already use, auto-
  // joined on connect — no subscribe_patient needed). Emitted ONLY here,
  // after successful persistence — never on update()/deactivate() (U2.1
  // confirmed neither changes "Total pacientes", since findAll's count has
  // no isActive filter). Payload carries just enough for the receiver to
  // know something changed, not what — canonical refresh is GET /patients.
  async create(userId: string, dto: CreatePatientDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const patient = await repo.create(medico.id, dto)
    this.io?.to(`user:${userId}`).emit('patient_created', {
      patientId: patient.id,
    })
    return patient
  }

  // INT-21 — patient_updated. Real contract: emitted only here and in
  // deactivate() below (the two places a Paciente row actually changes),
  // to room `patient:{patientId}` — same room as subscribe_patient/
  // unsubscribe_patient (INT-16/17) and prediction_completed (INT-19).
  // Never touches `user:{userId}` (that room is exclusively for new_alert).
  // V6.2 §3/§4/§5/§6/§10 — phone legacy-compatibility boundary.
  //
  // Audit (V6.2 §3): EditPatientModal always resends `phone` in full on
  // every submit (`form.phone.trim() || null`), never omitting it just
  // because it wasn't the field the doctor actually changed — confirmed by
  // direct read of EditPatientModal.tsx's `submit()`. So UpdatePatientDto
  // cannot enforce canonical format for every non-null `phone` string: a
  // patient with a pre-V6 legacy value (e.g. "+52 33 1234 5678", with
  // spaces) would then fail EVERY future edit, even one that only changes
  // firstName — exactly what V6.2 §4 forbids.
  //
  // Resolution: `UpdatePatientDto` (patient.dto.ts) now only enforces
  // syntactic sanity (string, ≤20 chars) on `phone`, not canonical format.
  // Here — where the CURRENTLY PERSISTED Patient is available — a
  // non-null, non-undefined `dto.phone` is classified as:
  //   - IDENTICAL to the stored value → an unchanged resend of a
  //     (possibly legacy) phone → allowed through untouched, never
  //     re-validated, never auto-normalized;
  //   - DIFFERENT from the stored value → a genuine new/changed phone →
  //     must satisfy the canonical E.164 contract (isCanonicalPhone),
  //     rejected with the same PHONE_MESSAGE Create uses otherwise.
  // `dto.phone === undefined` (field omitted) and `dto.phone === null`
  // (explicit clear) are both left entirely alone — neither is a "change
  // to validate" in the canonical-format sense, matching V6.2 §5's ACCEPT
  // list exactly. This is the narrowest correct validation placement: Zod
  // stays declarative for every other field, and only phone's one
  // legacy-compatibility exception needs the current row.
  async update(userId: string, patientId: string, dto: UpdatePatientDtoType) {
    const current = await this.getOne(userId, patientId)

    if (typeof dto.phone === 'string' && dto.phone !== current.phone) {
      if (!isCanonicalPhone(dto.phone)) {
        throw new ValidationError(PHONE_MESSAGE)
      }
    }

    const patient = await repo.update(patientId, dto)
    this.emitPatientUpdated(patient)
    return patient
  }

  async deactivate(userId: string, patientId: string) {
    await this.getOne(userId, patientId)
    const patient = await repo.deactivate(patientId)
    this.emitPatientUpdated(patient)
    return patient
  }

  async getHistory(userId: string, patientId: string, opts: HistoryQueryDtoType) {
    await this.getOne(userId, patientId)
    return repo.getHistory(patientId, opts)
  }

  // P2 — GET /patients/:patientId/timeline. Read-side aggregation only
  // (AGGREGATED per D-P1-01) — no new table, no writes, no side effects.
  // Ownership reuses the exact same getOne() check as getHistory() above.
  async getTimeline(userId: string, patientId: string, from?: Date, to?: Date): Promise<PatientTimelineEvent[]> {
    await this.getOne(userId, patientId)

    // Exactly the query set from section 27: HealthRecords in range,
    // Predictions in range, Alerts in range, and — only if `from` is
    // given — the single predecessor Prediction for RISK_CHANGE context
    // (section 19). No N+1: each is one query regardless of result size.
    const [records, predictionsInRange, alerts, predecessor] = await Promise.all([
      recordRepo.findInRange(patientId, from, to),
      predictionRepo.findInRange(patientId, from, to),
      alertRepo.findInRangeForPatient(patientId, from, to),
      from ? predictionRepo.findPredecessor(patientId, from) : Promise.resolve(null),
    ])

    const clinicalEvents = records.map(toClinicalRecordEvent)
    const predictionEvents = predictionsInRange.map(toPredictionEvent)
    const alertEvents = alerts.map(toAlertEvent)

    // The predecessor (if any) is prepended ONLY for deriving the first
    // in-range transition — predictionsInRange is already
    // predictedAt-asc/id-asc from the repository, and the predecessor is
    // strictly earlier than every item in it (predictedAt < from <= every
    // in-range predictedAt), so no re-sort is needed. It is never mapped
    // to its own PREDICTION event (section 19/20) — only predictionEvents
    // above (built from predictionsInRange alone) becomes PREDICTION
    // events in the response.
    const sequence = predecessor ? [predecessor, ...predictionsInRange] : predictionsInRange
    const riskChangeEvents = deriveRiskChanges(sequence)

    const events: PatientTimelineEvent[] = [
      ...clinicalEvents,
      ...predictionEvents,
      ...alertEvents,
      ...riskChangeEvents,
    ]
    return sortTimelineEvents(events)
  }

  private emitPatientUpdated(patient: { id: string; firstName: string; lastName: string; isActive: boolean }) {
    this.io?.to(`patient:${patient.id}`).emit('patient_updated', {
      patientId: patient.id,
      firstName: patient.firstName,
      lastName:  patient.lastName,
      isActive:  patient.isActive,
    })
  }

  private async getMedicoOrThrow(userId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access patients')
    return medico
  }
}
