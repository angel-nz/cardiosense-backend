import { Router } from 'express'
import type { RequestHandler } from 'express'
import { authenticate } from '@/middlewares/authenticate'
import * as ctrl from './dashboard.controller'

const router = Router()
const auth = authenticate as RequestHandler

router.use(auth)

// GET /api/dashboard/stats — single aggregated endpoint (predictionsToday,
// predictionsThisWeek, highRiskPatients, riskDistribution) rather than four
// separate endpoints, per Bloque I's explicit instruction (avoids
// multiplying requests against the F6-C rate-limit budget).
router.get('/stats', ctrl.getStats as RequestHandler)

export default router
