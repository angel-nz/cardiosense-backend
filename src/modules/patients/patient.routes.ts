import { Router } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreatePatientDto, UpdatePatientDto, PatientQueryDto, PatientParamDto, HistoryQueryDto } from './patient.dto'
import { TimelineQueryDto, TimelineParamDto } from './patient.timeline.dto'
import { createPatientController } from './patient.controller'

export function createPatientRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate
  const ctrl   = createPatientController(io)

  router.use(auth)

  router.get('/',         validate(PatientQueryDto, 'query'), withAuth(ctrl.list))
  router.post('/',        validate(CreatePatientDto),          withAuth(ctrl.create))
  router.get('/:id',      validate(PatientParamDto, 'params'), withAuth(ctrl.getOne))
  router.put('/:id',      validate(PatientParamDto, 'params'),
                          validate(UpdatePatientDto),           withAuth(ctrl.update))
  router.delete('/:id',   validate(PatientParamDto, 'params'), withAuth(ctrl.deactivate))
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
