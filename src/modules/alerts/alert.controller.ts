import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import type { Server as IOServer } from 'socket.io'
import { AlertService } from './alert.service'

export function createAlertController(io?: IOServer) {
  const svc = new AlertService(io)

  const list = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await svc.list(req.user.sub, req.query as never)
      res.json(result)
    } catch (err) { next(err) }
  }

  const markRead = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const alert = await svc.markRead(req.user.sub, req.params.id)
      res.json(alert)
    } catch (err) { next(err) }
  }

  const markAllRead = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await svc.markAllRead(req.user.sub)
      res.json(result)
    } catch (err) { next(err) }
  }

  return { list, markRead, markAllRead }
}
