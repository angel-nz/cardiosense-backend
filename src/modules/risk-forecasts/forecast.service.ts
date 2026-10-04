// NEW S2D — read-only forecast projection queries (doctor-facing).
// GETs never orchestrate, regenerate or write.
import { prisma } from '@/config/prisma'
import { ForbiddenError, NotFoundError } from '@/lib/errors'
import { paginate } from '@/types'
import { findCurrentSetWithForecasts, findSupersededHistory } from './forecast.repository'
import { toForecastSetView } from './forecast.serializer'
import { tryGetCurrentModelContract } from './forecast.modelContract'
import type { ForecastHistoryQueryDtoType } from './forecast.dto'

export class RiskForecastService {
  // Same ownership/concealment rule as every patient-scoped read: hidden
  // patients behave exactly like nonexistent ones (404).
  private async ownedPatient(userId: string, patientId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access risk projections')
    const patient = await prisma.paciente.findFirst({ where: { id: patientId, medicoId: medico.id, isHidden: false }, select: { id: true, isActive: true } })
    if (!patient) throw new NotFoundError('Patient')
    return patient
  }

  async getCurrent(userId: string, patientId: string) {
    const patient = await this.ownedPatient(userId, patientId)
    const set = await findCurrentSetWithForecasts(patientId)
    const model = set ? await tryGetCurrentModelContract() : null
    return {
      patientId,
      lifecycle: patient.isActive ? 'ACTIVE' : 'PATIENT_INACTIVE',
      data: set ? toForecastSetView(set, model) : null,
    }
  }

  async getHistory(userId: string, patientId: string, q: ForecastHistoryQueryDtoType) {
    await this.ownedPatient(userId, patientId)
    const { data, total } = await findSupersededHistory(patientId, q.page, q.limit)
    const model = data.length ? await tryGetCurrentModelContract() : null
    return paginate(data.map(s => toForecastSetView(s, model)), total, q.page, q.limit)
  }
}
