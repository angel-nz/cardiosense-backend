import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import { RiskForecastService } from './forecast.service'

export function createForecastController() {
  const svc = new RiskForecastService()
  const current = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try { res.json(await svc.getCurrent(req.user.sub, req.params.patientId)) } catch (err) { next(err) }
  }
  const history = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try { res.json(await svc.getHistory(req.user.sub, req.params.patientId, req.query as any)) } catch (err) { next(err) }
  }
  return { current, history }
}
