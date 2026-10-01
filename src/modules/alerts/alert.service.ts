import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { AlertRepository } from './alert.repository'
import { isRealtimeNotificationEnabled } from './realtimeNotification'
import { paginate } from '@/types'
import type { AlertSeverity, AlertType } from '@prisma/client'
import type { AlertQueryDtoType } from './alert.dto'
import type { RealtimeAlertCategory } from './realtimeNotification'
import type { Server as IOServer } from 'socket.io'

const repo = new AlertRepository()

export class AlertService {
  constructor(private readonly io?: IOServer) {}

  // Y4 — `realtimeCategory` is transient delivery metadata (Y4 §5/§6), not
  // persisted: it exists only to decide whether the `new_alert` realtime
  // event below is delivered. The caller (prediction.service.ts) already
  // knows exactly why it's creating this Alert — this method never infers
  // the category from severity/message (Y4 §31).
  async create(data: {
    patientId:        string
    predictionId:     string
    severity:         string
    message:          string
    medicoUserId:     string
    patientName:      string
    riskScore:        number
    realtimeCategory: RealtimeAlertCategory
  }) {
    // Clinical persistence happens unconditionally, before any preference is
    // ever consulted (Y4 §22/§32) — nothing below this line can prevent or
    // roll back Alert creation.
    const alert = await repo.create({
      patientId:    data.patientId,
      predictionId: data.predictionId,
      severity:     data.severity as AlertSeverity,
      message:      data.message,
    })

    // Y4-FIX2 — alerts_changed: an ungated, canonical-data-invalidation
    // signal, deliberately separate from `new_alert` (the notification-
    // preference-gated, presentation-only event below). Turning a realtime
    // notification category OFF must never leave the Alerts collection/
    // total stale — that requires this event to fire unconditionally,
    // before the preference is even resolved. Minimal payload (ids only) —
    // never a fabricated Alert DTO — so every consumer must refetch
    // canonical data, never construct an Alert from this alone. Best-effort,
    // same Y4-FIX1 pattern: a synchronous emit failure here must not affect
    // the already-persisted Alert or reject this call.
    try {
      this.io?.to(`user:${data.medicoUserId}`).emit('alerts_changed', {
        alertId:   alert.id,
        patientId: data.patientId,
      })
    } catch (err) {
      logger.warn('alerts_changed emit failed — Alert already persisted, invalidation signal skipped', {
        medicoUserId: data.medicoUserId,
        alertId:      alert.id,
        err:          err instanceof Error ? err.message : String(err),
      })
    }

    // Y4 §22/§23 — preference resolved AFTER persistence, gating ONLY the
    // `new_alert` emit below. isRealtimeNotificationEnabled() already
    // catches its own failures and defaults to enabled — nothing here can
    // make a preference-read failure affect the Alert that already exists.
    const realtimeEnabled = await isRealtimeNotificationEnabled(data.medicoUserId, data.realtimeCategory)
    if (realtimeEnabled) {
      // Y4-FIX1 — `new_alert` is optional presentation/delivery, never
      // clinical/provenance data (Y4-FIX1 §1). An unexpected synchronous
      // throw from this emit (e.g. a Socket.IO internal error) must not
      // reject create() — that would incorrectly surface as an
      // AlertService/PredictionService failure for an Alert that is
      // already safely persisted above. Narrow: wraps ONLY this emit, not
      // dashboard_activity_changed below or the persisted Alert's return.
      try {
        this.io?.to(`user:${data.medicoUserId}`).emit('new_alert', {
          id:          alert.id,
          patientId:   data.patientId,
          patientName: data.patientName,
          severity:    data.severity.toLowerCase(),
          message:     data.message,
          riskScore:   data.riskScore,
          createdAt:   alert.createdAt,
        })
      } catch (err) {
        // Never rethrown — the persisted Alert remains authoritative
        // regardless of whether its realtime delivery succeeded. Logged
        // context is limited to ids/category/error message — no tokens,
        // secrets, or patient PII (patientName/message are deliberately
        // excluded from this log line).
        logger.warn('new_alert emit failed — Alert already persisted, delivery skipped', {
          medicoUserId: data.medicoUserId,
          alertId:      alert.id,
          category:     data.realtimeCategory,
          err:          err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      logger.info('new_alert suppressed by user notification preference', {
        medicoUserId: data.medicoUserId,
        alertId:      alert.id,
        category:     data.realtimeCategory,
      })
    }

    // Y4 §24 — dashboard_activity_changed is NOT a user-facing notification
    // covered by NotificationPreference; it is the same invalidation-only
    // "refetch your persisted data" signal every other domain event in this
    // codebase uses (see O4.2 elsewhere), and it must keep firing regardless
    // of the realtime-notification preference so persisted-data UI (the
    // Dashboard Calendar, unread state on refetch, etc.) never desyncs from
    // what's actually in the database. Redundant with the
    // dashboard_activity_changed prediction.service.ts already emits for
    // this same predict() call — unchanged, pre-existing, accepted-by-design
    // duplication (O4.1), not something Y4 introduces or removes.
    this.io?.to(`user:${data.medicoUserId}`).emit('dashboard_activity_changed', {
      patientId: data.patientId,
      eventDate: alert.createdAt,
    })

    return alert
  }

  // Z5 — Configurable Information Alerts. The ONE entry point every one of
  // the (now three, post-Z6-R2) information triggers (patient.service.ts::
  // create/update, record.service.ts::create) goes through — never
  // duplicated per-caller, so "persist unconditionally, emit
  // alerts_changed unconditionally, gate only new_alert on the matching
  // preference" is enforced in exactly one place, the same shape create()
  // above already established for prediction-generated Alerts.
  // (user.routes.ts's PATCH /me/profile was a fourth caller, for the
  // doctor-profile information alert, before Z6-R2 removed that trigger
  // entirely — see that route's own comments.)
  //
  // Ownership (schema.prisma Alert model comment has the full invariant):
  // exactly one of patientId/medicoId must be set — patientId for every
  // current patient-scoped event; medicoId (the Medico.id PK, NOT the
  // User.id) is the doctor-scoped path, which no live caller populates
  // today (its one producer, the doctor-profile information alert, was
  // removed by Z6-R2) but remains supported here as generic infrastructure, not
  // removed. This is asserted here, not left to the caller's discipline
  // alone, because a silently-both-null Alert would violate the invariant
  // with no DB-level guard to catch it (no CHECK constraint — see schema
  // comment).
  // `medicoUserId` (User.id) is ALWAYS required regardless of scope — it
  // is what the realtime room (`user:${medicoUserId}`) and the
  // NotificationPreference lookup are keyed on, and it is never the same
  // id as `medicoId` (Medico.id), so it cannot be derived from it without
  // an extra query — every caller already has it in hand (the
  // authenticated request's own userId) and passes it explicitly, exactly
  // like create() above already requires medicoUserId from its caller.
  // Z5-FIX1 — this method is AUXILIARY/SECONDARY notification
  // infrastructure: by the time any of its four callers
  // (patient.service.ts::create/update, record.service.ts::create,
  // user.routes.ts's PATCH /me/profile) invoke it, their own primary
  // domain mutation has ALREADY been persisted and committed — none of
  // them run this inside the same transaction as that mutation (there
  // isn't always one to join: only PATCH /me/profile's User/Medico update
  // uses `$transaction`, and even there it has already resolved by the
  // time this method is called). An Alert this method creates documents
  // that committed mutation; it is never a precondition for it.
  //
  // Before this fix, a failure anywhere in this method (the
  // ownership-invariant check, or the Alert INSERT itself — preference
  // resolution and the two realtime emits already had their own isolation,
  // unchanged below) propagated straight out of the `await
  // createInformationAlert(...)` call at each trigger site. None of those
  // four call sites wraps that call in its own try/catch, so the error
  // reached the Express route handler's existing try/catch, which calls
  // `next(err)` → errorHandler.ts's generic fallback → a 500 "Internal
  // server error" response — telling the client the request failed even
  // though the patient/record/profile write had already committed. That
  // could read as "please retry", risking a duplicate patient, a
  // duplicate health record, or a doctor re-submitting a profile edit
  // that already saved.
  //
  // Fix: this method now never throws. Every failure path is caught here,
  // logged with enough context to diagnose (type, patientId/medicoId,
  // medicoUserId, the original error — never the clinical message text),
  // and swallowed — the primary mutation's own success is never
  // retroactively falsified. This isolation is scoped to THIS method
  // alone: AlertService.create() (the pre-existing, prediction-generated
  // Alert path used by prediction.service.ts) is completely untouched —
  // its own failure behavior was never asked to change, and
  // createInformationAlert has no other caller, so narrowing the
  // try/catch to this method's body cannot weaken anything elsewhere.
  //
  // Each domain operation still calls this at most once (no retry loop
  // here or at any call site) — on failure, simply zero Alerts are
  // created for that operation, never more than the intended one.
  async createInformationAlert(data: {
    type:         AlertType
    patientId?:   string
    medicoId?:    string
    medicoUserId: string
    // Only meaningful (and only ever passed) for a patient-scoped alert —
    // carried into the new_alert payload's patientName field exactly like
    // create() above does. Left undefined for the doctor-scoped event.
    patientName?: string
    message:      string
  }): Promise<void> {
    try {
      if (Boolean(data.patientId) === Boolean(data.medicoId)) {
        // Programmer error, not a user-facing condition — no caller here
        // is ever driven by untrusted request input for
        // patientId/medicoId themselves (see each trigger site). Caught
        // by the outer try/catch below like any other failure in this
        // method — it must not surface as a 500 for an already-committed
        // primary mutation either.
        throw new Error(
          'AlertService.createInformationAlert requires exactly one of patientId or medicoId',
        )
      }

      // Same ordering guarantee as create() above: persistence happens
      // unconditionally, before any preference is ever consulted — nothing
      // below this line can prevent or roll back Alert creation. A
      // failure here (e.g. a transient DB error) is caught by the outer
      // try/catch — no alerts_changed/new_alert follows, since there is
      // nothing to signal about.
      const alert = await repo.create({
        patientId: data.patientId,
        medicoId:  data.medicoId,
        type:      data.type,
        severity:  'INFO',
        message:   data.message,
      })

      // alerts_changed — ungated canonical-data-invalidation signal, same
      // Y4-FIX2 contract as create() above: fires regardless of the
      // realtime preference, so AlertsPage/unread counts never desync from
      // what's actually in the database even when the matching toggle is
      // off. Best-effort — never affects the already-persisted Alert.
      // Unchanged by this fix (already isolated on its own).
      try {
        this.io?.to(`user:${data.medicoUserId}`).emit('alerts_changed', {
          alertId:   alert.id,
          patientId: data.patientId ?? null,
        })
      } catch (err) {
        logger.warn('alerts_changed emit failed — Alert already persisted, invalidation signal skipped', {
          medicoUserId: data.medicoUserId,
          alertId:      alert.id,
          err:          err instanceof Error ? err.message : String(err),
        })
      }

      // new_alert — preference-gated realtime popup, resolved AFTER
      // persistence (same ordering as create() above). AlertType's member
      // names are identical to the four INFO_* RealtimeAlertCategory values
      // by construction (realtimeNotification.ts) — this is the ONE place
      // that identity is relied on. isRealtimeNotificationEnabled() already
      // catches its own failures and defaults to enabled (realtimeNotification.ts)
      // — unchanged by this fix, already isolated on its own.
      const realtimeEnabled = await isRealtimeNotificationEnabled(
        data.medicoUserId,
        data.type as unknown as RealtimeAlertCategory,
      )
      if (realtimeEnabled) {
        try {
          this.io?.to(`user:${data.medicoUserId}`).emit('new_alert', {
            id:          alert.id,
            patientId:   data.patientId ?? null,
            patientName: data.patientName,
            severity:    'info',
            message:     data.message,
            createdAt:   alert.createdAt,
          })
        } catch (err) {
          logger.warn('new_alert emit failed — Alert already persisted, delivery skipped', {
            medicoUserId: data.medicoUserId,
            alertId:      alert.id,
            type:         data.type,
            err:          err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        logger.info('new_alert suppressed by user notification preference', {
          medicoUserId: data.medicoUserId,
          alertId:      alert.id,
          type:         data.type,
        })
      }
    } catch (err) {
      // Z5-FIX1 — reached only by a failure in the ownership-invariant
      // check or the Alert INSERT itself (repo.create); every other
      // failure surface in this method already has its own inner
      // try/catch above. The primary domain mutation this Alert would
      // have documented has already committed by the time any of this
      // method's callers invoke it, so nothing here can or should roll
      // that back — this is purely diagnostic logging for an Alert that
      // will simply not exist. `message` (may carry a patient's name) is
      // deliberately excluded from this log line, same restraint as the
      // emit-failure logs above.
      logger.error('createInformationAlert failed — primary mutation already committed, no Alert was created', {
        type:         data.type,
        patientId:    data.patientId ?? null,
        medicoId:     data.medicoId ?? null,
        medicoUserId: data.medicoUserId,
        err:          err instanceof Error ? err.message : String(err),
      })
    }
  }

  async list(userId: string, query: AlertQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const { data, total, unreadCount } = await repo.findByMedico(medico.id, {
      page:     query.page,
      limit:    query.limit,
      unread:   query.unread,
      severity: query.severity as AlertSeverity | undefined,
      search:   query.search,
    })
    return {
      ...paginate(data, total, query.page, query.limit),
      unreadCount,
    }
  }

  async markRead(userId: string, alertId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    const alert  = await repo.findById(alertId)
    if (!alert) throw new NotFoundError('Alert')

    // Z5 — ownership now has two paths (see schema.prisma Alert model
    // comment): patient-scoped (the pre-existing check, unchanged for
    // every prediction/INFO_PATIENT_*/INFO_HEALTH_RECORD_CREATED Alert) or
    // doctor-scoped (alert.medicoId set directly — no live AlertType
    // populates this path today, since Z6-R2 removed its one producer,
    // the doctor-profile information alert, but the check is kept generic
    // rather than deleted). Exactly one branch runs — alert.patientId and alert.medicoId
    // are never both set (the same invariant createInformationAlert
    // enforces at creation) — and a malformed row with NEITHER set fails
    // safe here too (the ternary's else-branch compares alert.medicoId,
    // null, against medico.id, never true).
    // Z8 §30 — isHidden=false added to the patient-scoped ownership check,
    // consistent with ownedByMedico() in alert.repository.ts (used by
    // list/unreadCount/markAllRead above). Safe: both branches already
    // collapse to the same generic ForbiddenError('Alert not accessible')
    // below regardless of cause, so this introduces no new leak — a hidden
    // patient's alert simply becomes "not accessible" like any foreign one.
    const owned = alert.patientId
      ? Boolean(await prisma.paciente.findFirst({ where: { id: alert.patientId, medicoId: medico.id, isHidden: false } }))
      : alert.medicoId === medico.id
    if (!owned) throw new ForbiddenError('Alert not accessible')

    return repo.markRead(alertId)
  }

  async markAllRead(userId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    await repo.markAllRead(medico.id)
    return { success: true }
  }

  private async getMedicoOrThrow(userId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access alerts')
    return medico
  }
}
