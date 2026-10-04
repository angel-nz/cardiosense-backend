// NEW S2D — GET-only risk PROJECTION endpoints (no write route exists).
import { Router } from 'express'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { ForecastHistoryQueryDto, ForecastPatientParamDto } from './forecast.dto'
import { createForecastController } from './forecast.controller'

export function createRiskForecastRouter() {
  const router = Router()
  const ctrl = createForecastController()
  router.use(authenticate)
  // GET /api/risk-forecasts/patient/:patientId/current
  router.get('/patient/:patientId/current', validate(ForecastPatientParamDto, 'params'), withAuth(ctrl.current))
  // GET /api/risk-forecasts/patient/:patientId/history?page&limit   (superseded sets; API-only in v1, A10)
  router.get('/patient/:patientId/history', validate(ForecastPatientParamDto, 'params'), validate(ForecastHistoryQueryDto, 'query'), withAuth(ctrl.history))
  return router
}
