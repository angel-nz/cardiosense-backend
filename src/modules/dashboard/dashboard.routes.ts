import { Router } from 'express'
import type { RequestHandler } from 'express'
import { authenticate } from '@/middlewares/authenticate'
import { validate } from '@/middlewares/validate'
import { TimelineQueryDto } from '@/modules/patients/patient.timeline.dto'
import * as ctrl from './dashboard.controller'

const router = Router()
const auth = authenticate as RequestHandler

router.use(auth)

// GET /api/dashboard/stats — single aggregated endpoint (predictionsToday,
// predictionsThisWeek, highRiskPatients, riskDistribution) rather than four
// separate endpoints, per Bloque I's explicit instruction (avoids
// multiplying requests against the F6-C rate-limit budget).
router.get('/stats', ctrl.getStats as RequestHandler)

// O2 — GET /api/dashboard/calendar. Reuses P2's TimelineQueryDto verbatim
// (patient.timeline.dto.ts) — identical from/to semantics (YYYY-MM-DD in
// America/Mexico_City, or full ISO instant; `to` exclusive), no duplicated
// validation logic.
router.get('/calendar', validate(TimelineQueryDto, 'query'), ctrl.getCalendar)

export default router
