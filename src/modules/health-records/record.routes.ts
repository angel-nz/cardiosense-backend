import { Router } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreateRecordDto } from './record.dto'
import { createRecordController } from './record.controller'

export function createRecordRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate
  const ctrl   = createRecordController(io)

  router.use(auth)

  // POST /health-records
  router.post('/', validate(CreateRecordDto), withAuth(ctrl.create))

  // GET /health-records/:id
  router.get('/:id', withAuth(ctrl.getOne))

  // GET /health-records/patient/:patientId
  router.get('/patient/:patientId', withAuth(ctrl.listByPatient))

  // U3.2 — GET /health-records/patient/:patientId/latest
  router.get('/patient/:patientId/latest', ctrl.getLatest)

  return router
}
