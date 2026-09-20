import type { Request, Response, NextFunction } from 'express'
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

  // U3.2 — GET /health-records/patient/:patientId/latest. Typed without an
  // explicit AuthRequest parameter (same technique already used for
  // patient.controller.ts::getTimeline in P2 and dashboard.controller.ts::
  // getCalendar in O2) so this handler doesn't need its own
  // `as RequestHandler` cast at the router — avoids adding another
  // instance of the pre-existing AuthRequest/RequestHandler TS2352
  // mismatch that affects every other route handler in this backend.
  // Returns the patient's most recent HealthRecord, or `null` when none
  // exists yet — a patient with no prior clinical observation is a normal
  // state, not an error (never 404 for that case; 404 is reserved for the
  // existing ownership-hiding behavior when the patient doesn't belong to
  // this doctor, thrown by svc.getLatest's assertPatientOwnership).
  const getLatest = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const record = await svc.getLatest(userId, req.params.patientId)
      res.json(record)
    } catch (err) { next(err) }
  }

  return { create, listByPatient, getOne, getLatest }
}
