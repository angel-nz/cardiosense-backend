import type { Request, Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import type { Server as IOServer } from 'socket.io'
import { PatientService } from './patient.service'

export function createPatientController(io?: IOServer) {
  const svc = new PatientService(io)

  const list = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await svc.list(req.user.sub, req.query as never)
      res.json(result)
    } catch (err) { next(err) }
  }

  const getOne = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const patient = await svc.getOne(req.user.sub, req.params.id)
      res.json(patient)
    } catch (err) { next(err) }
  }

  const create = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const patient = await svc.create(req.user.sub, req.body)
      res.status(201).json(patient)
    } catch (err) { next(err) }
  }

  const update = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const patient = await svc.update(req.user.sub, req.params.id, req.body)
      res.json(patient)
    } catch (err) { next(err) }
  }

  const deactivate = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await svc.deactivate(req.user.sub, req.params.id)
      res.json({ success: true })
    } catch (err) { next(err) }
  }

  const getHistory = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query as { from?: string; to?: string }
      const history = await svc.getHistory(req.user.sub, req.params.id, from, to)
      res.json(history)
    } catch (err) { next(err) }
  }

  // P2 — GET /patients/:patientId/timeline. Typed without an explicit
  // AuthRequest parameter (unlike the other handlers above) specifically
  // so it doesn't need its own `as RequestHandler` cast at the router —
  // same technique already used for the analogous case in
  // user.routes.ts (Bloque N-B) to avoid adding another instance of the
  // pre-existing AuthRequest/RequestHandler TS2352 mismatch.
  const getTimeline = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const { from, to } = req.query as unknown as { from?: Date; to?: Date }
      const data = await svc.getTimeline(userId, req.params.patientId, from, to)
      res.json({ data })
    } catch (err) { next(err) }
  }

  return { list, getOne, create, update, deactivate, getHistory, getTimeline }
}
