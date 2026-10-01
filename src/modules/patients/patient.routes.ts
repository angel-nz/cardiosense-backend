import { Router } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import {
  CreatePatientDto, UpdatePatientDto, PatientQueryDto, PatientParamDto, HistoryQueryDto,
  PatientStatusDto, PatientVisibilityDto, HiddenPatientQueryDto, BulkVisibilityDto,
} from './patient.dto'
import { TimelineQueryDto, TimelineParamDto } from './patient.timeline.dto'
import { createPatientController } from './patient.controller'

export function createPatientRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate
  const ctrl   = createPatientController(io)

  router.use(auth)

  router.get('/',         validate(PatientQueryDto, 'query'), withAuth(ctrl.list))
  router.post('/',        validate(CreatePatientDto),          withAuth(ctrl.create))

  // Z8 §45 — these static /visibility/* and /inactive/* routes MUST be
  // registered BEFORE the dynamic '/:id' routes below, or Express would
  // treat "visibility"/"inactive" as a patient id and these would never be
  // reached.
  //
  // GET /patients/visibility/hidden — the Settings -> Pacientes hidden list
  // (Z8 §17). Minimal patient summary, paginated/searchable.
  router.get('/visibility/hidden',
    validate(HiddenPatientQueryDto, 'query'), withAuth(ctrl.listHidden))

  // GET /patients/visibility/summary — visibleInactive/hiddenInactive counts
  // for Settings -> Pacientes (Z8 §18). Never reused as Dashboard counts.
  router.get('/visibility/summary', withAuth(ctrl.getVisibilitySummary))

  // PATCH /patients/inactive/visibility — bulk hide-all-inactive /
  // show-all-hidden (Z8 §19).
  router.patch('/inactive/visibility',
    validate(BulkVisibilityDto), withAuth(ctrl.bulkSetVisibility))

  router.get('/:id',      validate(PatientParamDto, 'params'), withAuth(ctrl.getOne))
  router.put('/:id',      validate(PatientParamDto, 'params'),
                          validate(UpdatePatientDto),           withAuth(ctrl.update))

  // Z8 §6/§47 — DELETE /:id removed entirely. Historical behavior was a soft
  // deactivate; Z8 replaces it with the explicit status/visibility endpoints
  // below. Confirmed (repo-wide grep) zero remaining frontend consumers of
  // DELETE /patients/:id before removing this route.
  //
  // PATCH /patients/:id/status — { isActive: boolean } — the one explicit
  // lifecycle mutation (deactivate/reactivate). Z8 §7/§9.
  router.patch('/:id/status',
    validate(PatientParamDto, 'params'),
    validate(PatientStatusDto),          withAuth(ctrl.setStatus))

  // PATCH /patients/:id/visibility — { isHidden: boolean } — the one
  // explicit visibility mutation (hide/show). Never reactivates/deactivates
  // in the same call. Z8 §10/§11/§21/§22.
  router.patch('/:id/visibility',
    validate(PatientParamDto, 'params'),
    validate(PatientVisibilityDto),      withAuth(ctrl.setVisibility))

  // U5.2 — pagination/sorting query params for `records`; `predictions`
  // portion of the response is unaffected.
  router.get('/:id/history', validate(PatientParamDto, 'params'),
                              validate(HistoryQueryDto, 'query'), withAuth(ctrl.getHistory))

  // P2 — Patient Timeline. Separate :patientId param name from the rest of
  // this router's :id (matches the prompt's own endpoint contract,
  // D-P1-02) — no collision with '/:id/history' above since Express
  // matches by segment count/literal text, not param names.
  router.get('/:patientId/timeline',
    validate(TimelineParamDto, 'params'),
    validate(TimelineQueryDto, 'query'),
    ctrl.getTimeline)

  return router
}
