import { prisma } from '@/config/prisma'
import {
  NotFoundError, ForbiddenError, ValidationError,
  PatientMustBeInactiveToHideError,
} from '@/lib/errors'
// Z6-FIX1 — PHONE_MESSAGE now lives in lib/phone.ts alongside isCanonicalPhone
// (moved out of patient.dto.ts, which no longer defines it).
import { isCanonicalPhone, PHONE_MESSAGE } from '@/lib/phone'
import { PatientRepository } from './patient.repository'
import { paginate } from '@/types'
import type {
  CreatePatientDtoType, UpdatePatientDtoType, PatientQueryDtoType, HistoryQueryDtoType,
  HiddenPatientQueryDtoType,
} from './patient.dto'
import type { Server as IOServer } from 'socket.io'
import { HealthRecordRepository } from '@/modules/health-records/record.repository'
import { PredictionRepository } from '@/modules/predictions/prediction.repository'
import { AlertService } from '@/modules/alerts/alert.service'
import {
  toClinicalRecordEvent, toPredictionEvent,
  deriveRiskChanges, sortTimelineEvents,
  type PatientTimelineEvent,
} from './patient.timeline'

const repo = new PatientRepository()
const recordRepo = new HealthRecordRepository()
const predictionRepo = new PredictionRepository()

// Z5 — the exact fields that count as patient PERSONAL information for
// INFO_PATIENT_UPDATED, kept as one small, named function rather than
// inlined in update() below so Z6 (patient email) can extend this single
// list without touching anything else in this file. Deliberately
// EXCLUDES isActive — that is lifecycle/deletion state (Z7's domain), not
// personal information, and deactivate() below never calls this function
// at all (it has its own, separate emitPatientUpdated-only path). Compares
// the pre-update snapshot against the just-persisted row — never the raw
// UpdatePatientDtoType alone, since a field being PRESENT in the request
// body does not mean its value actually changed (see V6.2's own phone-
// resend precedent immediately above, in update()).
function personalInfoChanged(
  before: { firstName: string; lastName: string; birthDate: Date; sex: number; curp: string | null; phone: string | null; email: string | null },
  after:  { firstName: string; lastName: string; birthDate: Date; sex: number; curp: string | null; phone: string | null; email: string | null },
): boolean {
  return (
    before.firstName           !== after.firstName ||
    before.lastName            !== after.lastName ||
    before.birthDate.getTime() !== after.birthDate.getTime() ||
    before.sex                 !== after.sex ||
    before.curp                !== after.curp ||
    before.phone                !== after.phone ||
    // Z6 — already normalized (trim + lowercase, or null) by
    // UpdatePatientDto's PatientEmailField before reaching here, so a
    // same-normalized-value resend correctly compares equal and never
    // fires a spurious INFO_PATIENT_UPDATED.
    before.email                !== after.email
  )
}

export class PatientService {
  constructor(private readonly io?: IOServer) {}

  async list(userId: string, query: PatientQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    // X2 — `risk` (already validated/coerced to canonical uppercase by
    // PatientQueryDto) is now genuinely forwarded to the repository, which
    // filters dataset-wide, before pagination, on each patient's latest
    // Prediction — see patient.repository.ts. Previously accepted by
    // validation but silently dropped here.
    // Z8 §13 — `status` (ACTIVE/INACTIVE/ALL, default ACTIVE) composes with
    // search/risk exactly the same way; hidden patients are excluded
    // unconditionally inside repo.findAll regardless of which status is
    // requested — never something this service layer needs to re-enforce.
    const { data, total } = await repo.findAll(medico.id, {
      page:   query.page,
      limit:  query.limit,
      search: query.search,
      risk:   query.risk,
      status: query.status,
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

    // Z5 — INFO_PATIENT_CREATED. Created exactly once, ONLY after
    // repo.create() above has already succeeded (a failed creation throws
    // before reaching this line, so no Alert is ever created for a patient
    // that was never actually persisted). Service-layer only — no
    // controller-side duplicate (patient.controller.ts's create() just
    // awaits this method and returns its result).
    // PRE-R2F — the patient's full name is already carried in
    // `patientName` below, which Topbar/AlertsPage/AlertToast all render as
    // this Alert's own bold "title" line (see alertService.ts's
    // `patientName` flattening and each component's `alert.patientName ||
    // 'Notificación general'` row) — the name must not ALSO appear inside
    // `message`, or the doctor reads it twice for the same Alert.
    const alertSvc = new AlertService(this.io)
    await alertSvc.createInformationAlert({
      type:         'INFO_PATIENT_CREATED',
      patientId:    patient.id,
      medicoUserId: userId,
      patientName:  `${patient.firstName} ${patient.lastName}`,
      message:      'Paciente creado correctamente.',
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

    // Z5 — INFO_PATIENT_UPDATED, created only when actual personal
    // information changed (personalInfoChanged, top of file) — never
    // merely because this PATCH endpoint was called, and never for an
    // isActive-only change (deactivate() below has its own separate path
    // that never reaches this code at all). `current` is the pre-update
    // snapshot fetched above via getOne(), so this compares what was
    // actually stored before against what is actually stored now — not
    // the raw dto, which V6.2's phone precedent already established can
    // legitimately resend an unchanged value.
    // PRE-R2F — same duplication rule as create() above: `patientName`
    // already renders as this Alert's own title line, so `message` no
    // longer repeats the name.
    if (personalInfoChanged(current, patient)) {
      const alertSvc = new AlertService(this.io)
      await alertSvc.createInformationAlert({
        type:         'INFO_PATIENT_UPDATED',
        patientId:    patient.id,
        medicoUserId: userId,
        patientName:  `${patient.firstName} ${patient.lastName}`,
        message:      'Se actualizó la información personal del paciente.',
      })
    }

    return patient
  }

  // Z8 §6/§7/§8/§9 — replaces the old deactivate()/DELETE-route pairing.
  // PATCH /patients/:id/status, { isActive }. ONE explicit, reversible
  // lifecycle mutation, both directions:
  //   isActive: false -> deactivate (ACTIVE -> INACTIVE_VISIBLE, or a no-op
  //     if already inactive-visible)
  //   isActive: true  -> reactivate (INACTIVE_VISIBLE -> ACTIVE)
  // `getOne()` is the SAME isHidden:false-scoped lookup every other normal
  // patient endpoint uses (patient.repository.ts::findById) — a hidden
  // patient is therefore never found here either, satisfying Z8 §26's
  // "status endpoint reactivation attempt [on a hidden patient] -> not
  // found" requirement with no separate check needed: hidden-cannot-
  // reactivate-directly falls out of the lookup itself, not a distinct
  // business-error branch. Never touches `isHidden` — reactivating a
  // SHOWN-but-still-inactive patient is this same call; reactivating a
  // HIDDEN one requires SHOW (visibility endpoint) first, then this
  // endpoint, as two separate, deliberate actions (Z8 §9's required
  // sequence).
  //
  // PRE-R2B §9/§10/§12/§13/§16/§18 — a successful isActive TRANSITION now
  // also persists exactly one INFO_PATIENT_UPDATED information Alert (the
  // existing AlertType, no new one added — §19). "Transition" is the
  // operative word: `current` (the pre-update snapshot already fetched by
  // getOne() above) is compared against the just-persisted row, so the
  // documented no-op resend shape above (deactivating an already-inactive
  // patient) never fires a second, misleading lifecycle Alert — mirrors
  // exactly how update()'s personalInfoChanged() above already guards
  // against a no-change PATCH (§12's "exactly ONE Alert" / "no duplicate
  // because of a repeated call"). HIDE/SHOW (below) are never routed
  // through this method or this Alert producer at all (§16/§17) — the
  // generic personalInfoChanged() detector above also still excludes
  // isActive/isHidden by construction, so this lifecycle Alert and the
  // personal-info Alert can never both fire for the same request (§18).
  //
  // Consistency/transaction design (§13): deliberately NOT wrapped in a
  // Prisma $transaction with repo.setActive() above. This reuses
  // AlertService.createInformationAlert() exactly as create()/update()
  // already do — and that method is Z5-FIX1's explicit, documented
  // best-effort design: it never throws, so a failure inside it (DB error,
  // emit error) is caught/logged there and can never retroactively fail
  // this request or roll back the Paciente write that already committed
  // via repo.setActive() above. That already satisfies §13's requirements
  // without a new cross-service transaction: if repo.setActive() itself
  // fails, it throws before any Alert is ever attempted (no lifecycle
  // Alert, no false ActionNotification, no realtime notification — the
  // whole request fails); if it succeeds, the status change is
  // authoritative and persisted Alert documentation is best-effort on top
  // of it, same trade-off Z5-FIX1 already established and justified for
  // every other information-Alert trigger in this codebase — not a new
  // architecture introduced by this block.
  async setStatus(userId: string, patientId: string, isActive: boolean) {
    const current = await this.getOne(userId, patientId)
    const patient = await repo.setActive(patientId, isActive)
    this.emitPatientUpdated(patient)

    // PRE-R2F — same duplication rule: `patientName` already renders as
    // this Alert's own title line, so neither branch of `message` repeats
    // the name anymore.
    if (current.isActive !== patient.isActive) {
      const alertSvc = new AlertService(this.io)
      await alertSvc.createInformationAlert({
        type:         'INFO_PATIENT_UPDATED',
        patientId:    patient.id,
        medicoUserId: userId,
        patientName:  `${patient.firstName} ${patient.lastName}`,
        message:      patient.isActive
          ? 'Se reactivó al paciente.'
          : 'Se desactivó al paciente.',
      })
    }

    return patient
  }

  // Z8 §10/§11 — PATCH /patients/:id/visibility, { isHidden: true }. HIDE.
  // Preconditions (all enforced here, not left to the repository):
  //   - owned by the current doctor + not already hidden — `getOne()`'s
  //     isHidden:false-scoped lookup is exactly this check; a nonexistent,
  //     foreign, or already-hidden patient all resolve to the same
  //     NotFoundError, never a distinct "already hidden" leak.
  //   - isActive MUST already be false — PatientMustBeInactiveToHideError
  //     otherwise (Z8 §11's controlled business error); this method NEVER
  //     deactivates the patient itself to make the hide succeed (Z8 §35 —
  //     "no endpoint silently combines deactivate+hide").
  // Result: isActive stays false (untouched), isHidden becomes true. No
  // persisted Z5 Alert.
  async hide(userId: string, patientId: string) {
    const patient = await this.getOne(userId, patientId)
    if (patient.isActive) throw new PatientMustBeInactiveToHideError()
    const updated = await repo.setHidden(patientId, true)
    this.emitPatientUpdated(updated)
    return updated
  }

  // Z8 §10/§22 — PATCH /patients/:id/visibility, { isHidden: false }. SHOW.
  // Deliberately resolves the patient via findHiddenById (isHidden:true
  // scoped) rather than getOne() — this IS the one normal-surface exception
  // Z8 §26 carves out: a visibility-management endpoint may resolve a
  // hidden patient specifically in order to un-hide it. A patient that
  // isn't actually hidden (already shown, foreign, nonexistent) resolves to
  // nothing here either, same NotFoundError contract. Result: isActive
  // stays false (untouched — SHOW never reactivates; reactivation is a
  // separate, subsequent PATCH /patients/:id/status call, Z8 §9), isHidden
  // becomes false. No persisted Z5 Alert.
  async show(userId: string, patientId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    const patient = await repo.findHiddenById(patientId, medico.id)
    if (!patient) throw new NotFoundError('Patient')
    const updated = await repo.setHidden(patientId, false)
    this.emitPatientUpdated(updated)
    return updated
  }

  // Z8 §19 — PATCH /patients/inactive/visibility, { isHidden }. Bulk
  // hide-all-inactive-visible / show-all-hidden for the current doctor
  // only. repo.bulkSetVisibility already scopes its WHERE to
  // medicoId + isActive:false + the current opposite isHidden value, so an
  // ACTIVE patient or another doctor's patient is never touched by
  // construction, not merely by convention. Returns the real affected row
  // count (Z8 §20's ONE ActionNotification quotes this number — the
  // frontend never fabricates or estimates it).
  async bulkSetVisibility(userId: string, isHidden: boolean): Promise<{ affectedCount: number }> {
    const medico = await this.getMedicoOrThrow(userId)
    const affectedCount = await repo.bulkSetVisibility(medico.id, isHidden)
    return { affectedCount }
  }

  // Z8 §17 — GET /patients/visibility/hidden. The Settings -> Pacientes
  // hidden-patient management list. repo.findHidden is the one repository
  // method allowed to list isHidden:true rows; deliberately returns a
  // minimal summary shape (no predictions/healthRecords), matching Z8 §17's
  // "do not return clinical records/predictions here" instruction.
  async listHidden(userId: string, opts: HiddenPatientQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const { data, total } = await repo.findHidden(medico.id, {
      page: opts.page, limit: opts.limit, search: opts.search,
    })
    return paginate(data, total, opts.page, opts.limit)
  }

  // Z8 §18 — GET /patients/visibility/summary. Settings -> Pacientes'
  // "Inactivos visibles: N / Inactivos ocultos: N" counts, scoped to the
  // current doctor alone. Deliberately allowed to count hidden patients —
  // this IS the dedicated visibility-management surface Z8 carves that
  // exception out for (never reused as a Dashboard patient count).
  async getVisibilitySummary(userId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    return repo.getVisibilitySummary(medico.id)
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

    // Z2 — Alert-model events removed from the Patient timeline (was a 4th
    // parallel query, alertRepo.findInRangeForPatient; RISK_CHANGE is
    // unaffected — it is derived from Predictions, not read from the Alert
    // table). Query set: HealthRecords in range, Predictions in range, and
    // — only if `from` is given — the single predecessor Prediction for
    // RISK_CHANGE context (section 19). No N+1: each is one query
    // regardless of result size.
    const [records, predictionsInRange, predecessor] = await Promise.all([
      recordRepo.findInRange(patientId, from, to),
      predictionRepo.findInRange(patientId, from, to),
      from ? predictionRepo.findPredecessor(patientId, from) : Promise.resolve(null),
    ])

    const clinicalEvents = records.map(toClinicalRecordEvent)
    const predictionEvents = predictionsInRange.map(toPredictionEvent)

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
