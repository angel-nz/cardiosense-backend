import { prisma } from '@/config/prisma'
import type { CreateRecordDtoType } from './record.dto'

export class HealthRecordRepository {
  async create(userId: string, dto: CreateRecordDtoType) {
    return prisma.healthRecord.create({
      data: {
        patientId:     dto.patientId,
        age:           dto.age,
        currentSmoker: dto.currentSmoker,
        cigsPerDay:    dto.cigsPerDay,
        bpMeds:        dto.bpMeds,
        diabetes:      dto.diabetes,
        totChol:       dto.totChol,
        sysBP:         dto.sysBP,
        diaBP:         dto.diaBP,
        bmi:           dto.bmi,
        heartRate:     dto.heartRate,
        glucose:       dto.glucose,
        notes:         dto.notes,
        createdBy:     userId,
      },
    })
  }

  async findByPatient(patientId: string, limit: number) {
    return prisma.healthRecord.findMany({
      where:   { patientId },
      orderBy: { recordedAt: 'desc' },
      take:    limit,
    })
  }

  async findLatestByPatient(patientId: string) {
    return prisma.healthRecord.findFirst({
      where:   { patientId },
      orderBy: { recordedAt: 'desc' },
    })
  }

  async findById(id: string) {
    return prisma.healthRecord.findUnique({ where: { id } })
  }
}
