import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreateRecordDto } from './record.dto'
import { createRecordController } from './record.controller'

export function createRecordRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate as RequestHandler
  const ctrl   = createRecordController(io)

  router.use(auth)

  // POST /health-records
  router.post('/', validate(CreateRecordDto), ctrl.create as RequestHandler)

  // GET /health-records/:id
  router.get('/:id', ctrl.getOne as RequestHandler)

  // GET /health-records/patient/:patientId
  router.get('/patient/:patientId', ctrl.listByPatient as RequestHandler)

  // U3.2 — GET /health-records/patient/:patientId/latest
  router.get('/patient/:patientId/latest', ctrl.getLatest)

  return router
}
