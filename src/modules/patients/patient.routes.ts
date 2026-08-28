import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreatePatientDto, UpdatePatientDto, PatientQueryDto, PatientParamDto } from './patient.dto'
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
  router.get('/:id/history', validate(PatientParamDto, 'params'), ctrl.getHistory as RequestHandler)

  return router
}
