import { prisma } from '@/config/prisma'

export class DashboardRepository {
  // I1 — count only; scoping (patient.medicoId) applied inside Prisma, not
  // in application code.
  async countPredictionsInRange(medicoId: string, start: Date, end: Date): Promise<number> {
    return prisma.prediction.count({
      where: {
        patient: { medicoId },
        predictedAt: { gte: start, lt: end },
      },
    })
  }

  // I3 — only the timestamp is selected; bucketing by local day happens in
  // the service, over a dataset already bounded to one médico's one week.
  async findPredictedAtInRange(medicoId: string, start: Date, end: Date): Promise<Array<{ predictedAt: Date }>> {
    return prisma.prediction.findMany({
      where: {
        patient: { medicoId },
        predictedAt: { gte: start, lt: end },
      },
      select: { predictedAt: true },
    })
  }

  // I2/I4 — shared source: every patient of this médico (no pagination —
  // this is an aggregate, not a page) with only their single most recent
  // Prediction embedded (take: 1), same "current risk" definition already
  // used and validated by patient.repository.ts (Bloque B), reimplemented
  // here independently rather than imported, per the Bloque I instruction
  // to keep Dashboard's queries self-contained and auditable on their own.
  async findPatientsWithLatestRisk(medicoId: string): Promise<Array<{ predictions: Array<{ riskLevel: string }> }>> {
    return prisma.paciente.findMany({
      where: { medicoId },
      select: {
        predictions: {
          orderBy: { predictedAt: 'desc' },
          take: 1,
          select: { riskLevel: true },
        },
      },
    })
  }
}
