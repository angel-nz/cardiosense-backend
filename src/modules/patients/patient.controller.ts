import type { Response, NextFunction } from 'express'
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

  return { list, getOne, create, update, deactivate, getHistory }
}
