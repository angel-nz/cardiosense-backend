import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import type { Server as IOServer } from 'socket.io'
import { PredictionService } from './prediction.service'
import type { GlobalPredictionQueryDtoType, PatientPredictionQueryDtoType } from './prediction.dto'

export function createPredictionController(io?: IOServer) {
  const svc = new PredictionService(io)

  const predict = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await svc.predict(req.user.sub, req.body)
      res.status(201).json(result)
    } catch (err) { next(err) }
  }

  const listByPatient = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const opts = req.query as unknown as PatientPredictionQueryDtoType
      const result = await svc.listByPatient(req.user.sub, req.params.patientId, opts)
      res.json(result)
    } catch (err) { next(err) }
  }

  const listAll = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const opts = req.query as unknown as GlobalPredictionQueryDtoType
      const result = await svc.listAll(req.user.sub, opts)
      res.json(result)
    } catch (err) { next(err) }
  }

  const getOne = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const prediction = await svc.getOne(req.user.sub, req.params.id)
      res.json(prediction)
    } catch (err) { next(err) }
  }

  return { predict, listByPatient, listAll, getOne }
}
