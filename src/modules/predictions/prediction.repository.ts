import { prisma } from '@/config/prisma'
import type { RiskLevel } from '@prisma/client'

export class PredictionRepository {
  async create(data: {
    patientId:     string
    healthRecordId?: string
    riskScore:     number
    riskLevel:     RiskLevel
    anomalyScore:  number
    isAnomaly:     boolean
    modelVersion:  string
  }) {
    return prisma.prediction.create({ data })
  }

  async findByPatient(patientId: string, page: number, limit: number) {
    const skip = (page - 1) * limit
    const [data, total] = await prisma.$transaction([
      prisma.prediction.findMany({
        where:   { patientId },
        orderBy: { predictedAt: 'desc' },
        skip,
        take:    limit,
      }),
      prisma.prediction.count({ where: { patientId } }),
    ])
    return { data, total }
  }

  async findById(id: string) {
    return prisma.prediction.findUnique({ where: { id } })
  }

  async findLatestByPatient(patientId: string) {
    return prisma.prediction.findFirst({
      where:   { patientId },
      orderBy: { predictedAt: 'desc' },
    })
  }

  async listAll(medicoId: string, page: number, limit: number) {
    const skip = (page - 1) * limit
    const where = { patient: { medicoId } }
    const [data, total] = await prisma.$transaction([
      prisma.prediction.findMany({
        where,
        orderBy: { predictedAt: 'desc' },
        skip,
        take: limit,
        include: {
          patient: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.prediction.count({ where }),
    ])
    return { data, total }
  }

  async findByIdForMedico(id: string, medicoId: string) {
    return prisma.prediction.findFirst({
      where: { id, patient: { medicoId } },
    })
  }

  // P2 — Patient Timeline. Same [from, to) DB filter and asc+id ordering
  // as HealthRecordRepository.findInRange — also used, unsorted-again, as
  // the base sequence for RISK_CHANGE derivation.
  async findInRange(patientId: string, from?: Date, to?: Date) {
    return prisma.prediction.findMany({
      where: {
        patientId,
        ...(from || to ? {
          predictedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        } : {}),
      },
      orderBy: [{ predictedAt: 'asc' }, { id: 'asc' }],
    })
  }

  // P2 — Patient Timeline range-boundary case (section 19): the single
  // most recent Prediction strictly before `before`, used ONLY as context
  // to derive a RISK_CHANGE whose *current* Prediction is inside the
  // requested range — never returned as a PREDICTION event itself.
  async findPredecessor(patientId: string, before: Date) {
    return prisma.prediction.findFirst({
      where: { patientId, predictedAt: { lt: before } },
      orderBy: { predictedAt: 'desc' },
    })
  }
}
