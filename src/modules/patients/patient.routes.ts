import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreatePatientDto, UpdatePatientDto, PatientQueryDto, PatientParamDto, HistoryQueryDto } from './patient.dto'
import { TimelineQueryDto, TimelineParamDto } from './patient.timeline.dto'
import { createPatientController } from './patient.controller'

export function createPatientRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate as RequestHandler
  const ctrl   = createPatientController(io)

  router.use(auth)

  router.get('/',         validate(PatientQueryDto, 'query'), ctrl.list      as RequestHandler)
  router.post('/',        validate(CreatePatientDto),          ctrl.create    as RequestHandler)
  router.get('/:id',      validate(PatientParamDto, 'params'), ctrl.getOne    as RequestHandler)
  router.put('/:id',      validate(PatientParamDto, 'params'),
                          validate(UpdatePatientDto),           ctrl.update    as RequestHandler)
  router.delete('/:id',   validate(PatientParamDto, 'params'), ctrl.deactivate as RequestHandler)
  // U5.2 — pagination/sorting query params for `records`; `predictions`
  // portion of the response is unaffected.
  router.get('/:id/history', validate(PatientParamDto, 'params'),
                              validate(HistoryQueryDto, 'query'), ctrl.getHistory as RequestHandler)

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
