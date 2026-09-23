import { prisma } from '@/config/prisma'
import type { CreateRecordDtoType } from './record.dto'

// Persistence input: `age` is required here because the service derives it
// from Paciente.birthDate before calling create() (record.service.ts). The
// HTTP DTO keeps `age` optional and never trusts a client-sent value.
type CreateHealthRecordData = Omit<CreateRecordDtoType, 'age'> & { age: number }

export class HealthRecordRepository {
  async create(userId: string, dto: CreateHealthRecordData) {
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

  // U3.2 — added `id: 'desc'` tie-break for the (rare) case of two records
  // sharing an identical recordedAt — previously undefined/incidental
  // ordering for that exact tie. Safe, minimal addition; does not change
  // behavior for the overwhelming majority of cases where recordedAt
  // values differ.
  async findLatestByPatient(patientId: string) {
    return prisma.healthRecord.findFirst({
      where:   { patientId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    })
  }

  async findById(id: string) {
    return prisma.healthRecord.findUnique({ where: { id } })
  }

  // P2 — Patient Timeline. Filters in DB (patientId + optional [from, to)),
  // ascending by recordedAt (the timeline's global sort order — see
  // patient.timeline.ts::sortTimelineEvents) with a stable id tie-break so
  // repeated requests with identical data return identical order.
  async findInRange(patientId: string, from?: Date, to?: Date) {
    return prisma.healthRecord.findMany({
      where: {
        patientId,
        ...(from || to ? {
          recordedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        } : {}),
      },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    })
  }
}
