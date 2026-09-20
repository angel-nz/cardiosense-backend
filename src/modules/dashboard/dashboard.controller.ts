import type { Response, NextFunction, Request } from 'express'
import type { AuthRequest } from '@/types'
import { DashboardService } from './dashboard.service'

const svc = new DashboardService()

export async function getStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const stats = await svc.getStats(req.user.sub)
    res.json(stats)
  } catch (err) {
    next(err)
  }
}

// O2 — GET /api/dashboard/calendar. Typed without an explicit AuthRequest
// parameter (same technique already used for patient.controller.ts::getTimeline
// in P2, and user.routes.ts in Bloque N-B) so this handler doesn't need its
// own `as RequestHandler` cast at the router — avoids adding another
// instance of the pre-existing AuthRequest/RequestHandler TS2352 mismatch
// that affects every other route handler in this backend.
export async function getCalendar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as AuthRequest).user.sub
    const { from, to } = req.query as unknown as { from?: Date; to?: Date }
    const data = await svc.getCalendar(userId, from, to)
    res.json({ data })
  } catch (err) {
    next(err)
  }
}
