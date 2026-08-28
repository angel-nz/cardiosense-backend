import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import type { Server as IOServer } from 'socket.io'
import { HealthRecordService } from './record.service'

export function createRecordController(io?: IOServer) {
  const svc = new HealthRecordService(io)

  const create = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const record = await svc.create(req.user.sub, req.body)
      res.status(201).json(record)
    } catch (err) { next(err) }
  }

  const listByPatient = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const limit = Number(req.query.limit) || 50
      const records = await svc.listByPatient(req.user.sub, req.params.patientId, limit)
      res.json(records)
    } catch (err) { next(err) }
  }

  const getOne = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const record = await svc.getOne(req.user.sub, req.params.id)
      res.json(record)
    } catch (err) { next(err) }
  }

  return { create, listByPatient, getOne }
}
