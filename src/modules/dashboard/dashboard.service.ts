import { prisma } from '@/config/prisma'
import { ForbiddenError } from '@/lib/errors'
import { startOfLocalDay, startOfLocalWeek, addDays, toLocalISODate } from '@/lib/timezone'
import { DashboardRepository } from './dashboard.repository'
import type { DashboardCalendarEvent } from './dashboard.calendar'
import { buildClinicalCalendarEvents } from '@/modules/patients/clinicalCalendar'
import { currentPredictionsOfLatestClinicalRecord, predictionClinicalInstantsInRange } from '@/modules/patients/clinicalLatest'

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

    // NEW S3 — clinical-time-first: a Prediction belongs to the Guadalajara
    // day of its SOURCE record's effective clinical time (a back-dated record
    // entered today is not "today"), and a patient's current risk is the
    // Prediction of the EXACT clinically latest record (clinicalLatest.ts,
    // S3-FIX1 strict: none on that record ⇒ the patient is in no risk bucket).
    const visible = await prisma.paciente.findMany({ where: { medicoId: medico.id, isHidden: false }, select: { id: true } })
    const [todayInstants, weekInstants, latestByPatient] = await Promise.all([
      predictionClinicalInstantsInRange(medico.id, todayStart, todayEnd),
      predictionClinicalInstantsInRange(medico.id, weekStart, weekEnd),
      currentPredictionsOfLatestClinicalRecord(visible.map(p => p.id)),
    ])
    const patientsWithRisk = visible.map(p => ({ predictions: latestByPatient.has(p.id) ? [{ riskLevel: latestByPatient.get(p.id)!.riskLevel as string }] : [] }))

    return {
      predictionsToday: todayInstants.length,
      predictionsThisWeek: this.bucketByLocalDay(weekStart, weekInstants.map(predictedAt => ({ predictedAt }))),
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

    // Z2 — Alert-model events removed from the Dashboard calendar (was a
    // 4th parallel query, repo.findAlertsInRange; RISK_CHANGE is unaffected
    // — it is derived from Predictions, not read from the Alert table).
    // NEW S2E-FIX3 — same clinical-time builder as the Patient timeline
    // (clinicalCalendar.ts), scoped to this médico's visible patients: records
    // at their effective clinical time, AUTOMATIC predictions at their source
    // record's clinical time, LEGACY_UNKNOWN only inside record detail.
    // The builder's order (clinical time → recordedAt → record → type) is kept.
    const [patients, events] = await Promise.all([
      repo.findPatientIdentities(medico.id),
      buildClinicalCalendarEvents({ patient: { medicoId: medico.id, isHidden: false } }, from, to),
    ])
    const patientNameById = new Map(patients.map(p => [p.id, `${p.firstName} ${p.lastName}`]))
    return events.map(event => ({ ...event, patientName: patientNameById.get(event.patientId) ?? 'Paciente' }))
  }
}
