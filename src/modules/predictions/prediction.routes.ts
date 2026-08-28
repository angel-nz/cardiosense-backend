import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreatePredictionDto } from './prediction.dto'
import { createPredictionController } from './prediction.controller'

export function createPredictionRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate as RequestHandler
  const ctrl   = createPredictionController(io)

  router.use(auth)

  // POST /predictions  → run prediction
  router.post('/', validate(CreatePredictionDto), ctrl.predict as RequestHandler)

  // GET  /predictions  → list all (paginated)
  router.get('/', ctrl.listAll as RequestHandler)

  // GET  /predictions/:id
  router.get('/:id', ctrl.getOne as RequestHandler)

  // GET  /predictions/patient/:patientId
  router.get('/patient/:patientId', ctrl.listByPatient as RequestHandler)

  return router
}
