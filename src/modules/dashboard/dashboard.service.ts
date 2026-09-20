import { prisma } from '@/config/prisma'
import { ForbiddenError } from '@/lib/errors'
import { startOfLocalDay, startOfLocalWeek, addDays, toLocalISODate } from '@/lib/timezone'
import { DashboardRepository } from './dashboard.repository'
import {
  toClinicalRecordEvent, toPredictionEvent, toAlertEvent, deriveRiskChanges,
} from '@/modules/patients/patient.timeline'
import { sortDashboardCalendarEvents, type DashboardCalendarEvent } from './dashboard.calendar'

const repo = new DashboardRepository()

export interface DashboardStats {
  predictionsToday: number
  predictionsThisWeek: Array<{ date: string; count: number }>
  highRiskPatients: number
  riskDistribution: { high: number; moderate: number; low: number }
}

export class DashboardService {
  // medicoId is derived exclusively from the authenticated JWT's userId —
  // never accepted from query/body/headers. Same getMedicoOrThrow pattern
  // already used identically in patients/health-records/predictions/alerts.
  async getStats(userId: string): Promise<DashboardStats> {
    const medico = await this.getMedicoOrThrow(userId)
    const now = new Date()

    const todayStart = startOfLocalDay(now)
    const todayEnd = addDays(todayStart, 1)
    const weekStart = startOfLocalWeek(now)
    const weekEnd = addDays(weekStart, 7)

    const [predictionsToday, weekPredictions, patientsWithRisk] = await Promise.all([
      repo.countPredictionsInRange(medico.id, todayStart, todayEnd),
      repo.findPredictedAtInRange(medico.id, weekStart, weekEnd),
      repo.findPatientsWithLatestRisk(medico.id),
    ])

    return {
      predictionsToday,
      predictionsThisWeek: this.bucketByLocalDay(weekStart, weekPredictions),
      ...this.summarizeRisk(patientsWithRisk),
    }
  }

  // I3 — exactly 7 entries (Monday..Sunday), days without predictions
  // explicitly present with count 0, nothing outside the range counted
  // (the query itself already bounded the dataset to [weekStart, weekEnd)).
  private bucketByLocalDay(
    weekStart: Date,
    predictions: Array<{ predictedAt: Date }>,
  ): Array<{ date: string; count: number }> {
    const buckets = new Map<string, number>()
    for (let i = 0; i < 7; i++) {
      const dayStart = startOfLocalDay(addDays(weekStart, i))
      buckets.set(toLocalISODate(dayStart), 0)
    }
    for (const p of predictions) {
      const key = toLocalISODate(startOfLocalDay(p.predictedAt))
      if (buckets.has(key)) {
        buckets.set(key, (buckets.get(key) ?? 0) + 1)
      }
    }
    return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }))
  }

  // I2/I4 — one pass over the same source: a patient's "current risk" is
  // the riskLevel of their single most recent Prediction; patients with no
  // Prediction at all are simply skipped (never counted, never defaulted).
  private summarizeRisk(
    patients: Array<{ predictions: Array<{ riskLevel: string }> }>,
  ): { highRiskPatients: number; riskDistribution: { high: number; moderate: number; low: number } } {
    let high = 0, moderate = 0, low = 0
    for (const patient of patients) {
      const latest = patient.predictions[0]
      if (!latest) continue
      if (latest.riskLevel === 'HIGH') high++
      else if (latest.riskLevel === 'MODERATE') moderate++
      else if (latest.riskLevel === 'LOW') low++
    }
    return { highRiskPatients: high, riskDistribution: { high, moderate, low } }
  }

  private async getMedicoOrThrow(userId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access dashboard stats')
    return medico
  }

  // O2 — GET /api/dashboard/calendar. AGGREGATED (O1/D-P1-01) across ALL of
  // the médico's patients — no new table, no persisted TimelineEvent/RiskChange.
  async getCalendar(userId: string, from?: Date, to?: Date): Promise<DashboardCalendarEvent[]> {
    const medico = await this.getMedicoOrThrow(userId)

    // 4 independent, medico-scoped queries in parallel (O1.18/section 30/31).
    const [patients, records, predictionsInRange, alerts] = await Promise.all([
      repo.findPatientIdentities(medico.id),
      repo.findRecordsInRange(medico.id, from, to),
      repo.findPredictionsInRange(medico.id, from, to),
      repo.findAlertsInRange(medico.id, from, to),
    ])

    const patientNameById = new Map(patients.map(p => [p.id, `${p.firstName} ${p.lastName}`]))

    // O1-FIX/section 15,17: only patients with >=1 Prediction in range need
    // a predecessor at all — and only if `from` was actually given (no
    // lower bound means there's no "boundary" to preserve a transition
    // across). A 5th DB round trip is skipped entirely when there's
    // nothing relevant to look up, rather than firing an empty/useless
    // query.
    const relevantPatientIds = from ? [...new Set(predictionsInRange.map(p => p.patientId))] : []
    const predecessors = relevantPatientIds.length > 0
      ? await repo.findPredecessors(medico.id, relevantPatientIds, from as Date)
      : []

    // Section 14 — the one rule that matters most here: NEVER derive
    // RISK_CHANGE across a mixed, multi-patient sequence. Group each
    // patient's own predecessor (if any) + in-range Predictions
    // separately, run P2's unmodified deriveRiskChanges() once per group,
    // then combine. A Prediction from patient A is never compared against
    // one from patient B.
    const byPatient = new Map<string, { predecessor?: typeof predecessors[number]; inRange: typeof predictionsInRange }>()
    for (const pred of predecessors) {
      const group = byPatient.get(pred.patientId) ?? { inRange: [] }
      group.predecessor = pred
      byPatient.set(pred.patientId, group)
    }
    for (const p of predictionsInRange) {
      const group = byPatient.get(p.patientId) ?? { inRange: [] }
      group.inRange.push(p)
      byPatient.set(p.patientId, group)
    }

    const riskChangeEvents = Array.from(byPatient.values()).flatMap(group => {
      const sequence = group.predecessor ? [group.predecessor, ...group.inRange] : group.inRange
      return deriveRiskChanges(sequence)
    })

    const clinicalEvents = records.map(toClinicalRecordEvent)
    const predictionEvents = predictionsInRange.map(toPredictionEvent)
    const alertEvents = alerts.map(toAlertEvent)

    // Section 34 — decorate AFTER reusing P2's mappers as-is; patientName
    // never touches patient.timeline.ts's own types/functions.
    const decorated: DashboardCalendarEvent[] = [
      ...clinicalEvents, ...predictionEvents, ...alertEvents, ...riskChangeEvents,
    ].map(event => ({
      ...event,
      patientName: patientNameById.get(event.patientId) ?? 'Paciente',
    }))

    return sortDashboardCalendarEvents(decorated)
  }
}
