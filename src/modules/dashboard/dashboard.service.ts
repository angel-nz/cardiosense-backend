import { prisma } from '@/config/prisma'
import { ForbiddenError } from '@/lib/errors'
import { startOfLocalDay, startOfLocalWeek, addDays, toLocalISODate } from '@/lib/timezone'
import { DashboardRepository } from './dashboard.repository'

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
}
