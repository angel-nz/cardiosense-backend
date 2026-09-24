import { Router } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { CreatePredictionDto, GlobalPredictionQueryDto, PatientPredictionQueryDto } from './prediction.dto'
import { createPredictionController } from './prediction.controller'

export function createPredictionRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate
  const ctrl   = createPredictionController(io)

  router.use(auth)

  // POST /predictions  → run prediction
  router.post('/', validate(CreatePredictionDto), withAuth(ctrl.predict))

  // GET  /predictions  → list all (paginated)
  // U6.2 — now validated via the established project pattern (was
  // previously unvalidated manual `Number(req.query.page) || 1` parsing —
  // fixed as part of extending this contract).
  router.get('/', validate(GlobalPredictionQueryDto, 'query'), withAuth(ctrl.listAll))

  // GET  /predictions/:id
  router.get('/:id', withAuth(ctrl.getOne))

  // GET  /predictions/patient/:patientId
  // U8.2B — now validated (was previously unvalidated manual parsing);
  // added optional targetId deep-link resolution.
  router.get('/patient/:patientId', validate(PatientPredictionQueryDto, 'query'), withAuth(ctrl.listByPatient))

  return router
}
