import type { Request, Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import type { Server as IOServer } from 'socket.io'
import { PatientService } from './patient.service'
import { withClinicalLatest } from './clinicalLatest'
import type {
  HistoryQueryDtoType,
  PatientStatusDtoType,
  PatientVisibilityDtoType,
  HiddenPatientQueryDtoType,
  BulkVisibilityDtoType,
} from './patient.dto'

export function createPatientController(io?: IOServer) {
  const svc = new PatientService(io)
  // NEW S3 — every single-patient response carries the clinical-time read
  // model (latestClinicalAt + clinically latest Prediction), so a personal-
  // info edit can never move the user-visible "Última actualización".
  const decorate = async <T extends { id: string }>(p: T) => (await withClinicalLatest([p]))[0]

  const list = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await svc.list(req.user.sub, req.query as never)
      res.json(result)
    } catch (err) { next(err) }
  }

  const getOne = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const patient = await svc.getOne(req.user.sub, req.params.id)
      res.json(await decorate(patient))
    } catch (err) { next(err) }
  }

  const create = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const patient = await svc.create(req.user.sub, req.body)
      res.status(201).json(await decorate(patient))
    } catch (err) { next(err) }
  }

  const update = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const patient = await svc.update(req.user.sub, req.params.id, req.body)
      res.json(await decorate(patient))
    } catch (err) { next(err) }
  }

  // Z8 — PATCH /patients/:id/status. The one explicit lifecycle mutation —
  // isActive:false deactivates, isActive:true reactivates. Replaces the old
  // DELETE-based `deactivate` handler entirely (see patient.routes.ts — the
  // DELETE /:id route itself is removed, Z8 §6/§47).
  const setStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { isActive } = req.body as PatientStatusDtoType
      const patient = await svc.setStatus(req.user.sub, req.params.id, isActive)
      res.json(await decorate(patient))
    } catch (err) { next(err) }
  }

  // Z8 — PATCH /patients/:id/visibility. isHidden:true hides (requires the
  // patient already inactive — PatientMustBeInactiveToHideError otherwise),
  // isHidden:false shows (never reactivates — Z8 §10/§22).
  const setVisibility = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { isHidden } = req.body as PatientVisibilityDtoType
      const patient = isHidden
        ? await svc.hide(req.user.sub, req.params.id)
        : await svc.show(req.user.sub, req.params.id)
      res.json(await decorate(patient))
    } catch (err) { next(err) }
  }

  // Z8 — PATCH /patients/inactive/visibility. Bulk hide-all-inactive /
  // show-all-hidden for the current doctor. Returns { affectedCount }, never
  // one notification/row per patient (Z8 §19/§20).
  const bulkSetVisibility = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { isHidden } = req.body as BulkVisibilityDtoType
      const result = await svc.bulkSetVisibility(req.user.sub, isHidden)
      res.json(result)
    } catch (err) { next(err) }
  }

  // Z8 — GET /patients/visibility/hidden. The Settings -> Pacientes hidden
  // list. Minimal patient summary only (Z8 §17) — no clinical data.
  const listHidden = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const opts = req.query as unknown as HiddenPatientQueryDtoType
      const result = await svc.listHidden(req.user.sub, opts)
      res.json(result)
    } catch (err) { next(err) }
  }

  // Z8 — GET /patients/visibility/summary. Counts for Settings -> Pacientes
  // (visibleInactive/hiddenInactive) — intentionally NOT reused as Dashboard
  // patient counts (Z8 §18).
  const getVisibilitySummary = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const summary = await svc.getVisibilitySummary(req.user.sub)
      res.json(summary)
    } catch (err) { next(err) }
  }

  const getHistory = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const opts = req.query as unknown as HistoryQueryDtoType
      const history = await svc.getHistory(req.user.sub, req.params.id, opts)
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

  return {
    list, getOne, create, update,
    setStatus, setVisibility, bulkSetVisibility, listHidden, getVisibilitySummary,
    getHistory, getTimeline,
  }
}
