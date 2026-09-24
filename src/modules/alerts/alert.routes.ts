import { Router } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { AlertQueryDto, AlertParamDto } from './alert.dto'
import { createAlertController } from './alert.controller'

export function createAlertRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate
  const ctrl   = createAlertController(io)

  router.use(auth)

  // GET  /alerts
  router.get('/',
    validate(AlertQueryDto, 'query'),
    withAuth(ctrl.list),
  )

  // PATCH /alerts/read-all
  router.patch('/read-all', withAuth(ctrl.markAllRead))

  // PATCH /alerts/:id/read
  router.patch('/:id/read',
    validate(AlertParamDto, 'params'),
    withAuth(ctrl.markRead),
  )

  return router
}
