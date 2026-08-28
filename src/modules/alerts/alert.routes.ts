import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { Server as IOServer } from 'socket.io'
import { authenticate } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { AlertQueryDto, AlertParamDto } from './alert.dto'
import { createAlertController } from './alert.controller'

export function createAlertRouter(io?: IOServer) {
  const router = Router()
  const auth   = authenticate as RequestHandler
  const ctrl   = createAlertController(io)

  router.use(auth)

  // GET  /alerts
  router.get('/',
    validate(AlertQueryDto, 'query'),
    ctrl.list as RequestHandler,
  )

  // PATCH /alerts/read-all
  router.patch('/read-all', ctrl.markAllRead as RequestHandler)

  // PATCH /alerts/:id/read
  router.patch('/:id/read',
    validate(AlertParamDto, 'params'),
    ctrl.markRead as RequestHandler,
  )

  return router
}
