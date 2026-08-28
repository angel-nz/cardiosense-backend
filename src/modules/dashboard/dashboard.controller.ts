import type { Response, NextFunction } from 'express'
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
