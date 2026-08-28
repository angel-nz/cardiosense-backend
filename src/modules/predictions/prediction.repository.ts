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
}
