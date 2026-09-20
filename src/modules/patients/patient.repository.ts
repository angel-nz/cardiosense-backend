import { prisma } from '@/config/prisma'
import type { CreatePatientDtoType, UpdatePatientDtoType } from './patient.dto'

export class PatientRepository {
  async findAll(medicoId: string, opts: {
    page: number; limit: number; search?: string
  }) {
    const { page, limit, search } = opts
    const skip = (page - 1) * limit

    const where = {
      medicoId,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName:  { contains: search, mode: 'insensitive' as const } },
          { curp:      { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    }

    const [data, total] = await prisma.$transaction([
      prisma.paciente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          predictions: {
            orderBy: { predictedAt: 'desc' },
            take: 1,
            select: { riskLevel: true, riskScore: true, predictedAt: true },
          },
        },
      }),
      prisma.paciente.count({ where }),
    ])

    return { data, total }
  }

  async findById(id: string, medicoId: string) {
    return prisma.paciente.findFirst({
      where: { id, medicoId },
      include: {
        predictions: {
          orderBy: { predictedAt: 'desc' },
          take: 1,
          select: { riskLevel: true, riskScore: true, isAnomaly: true, predictedAt: true },
        },
      },
    })
  }

  async create(medicoId: string, dto: CreatePatientDtoType) {
    return prisma.paciente.create({
      data: {
        medicoId,
        firstName: dto.firstName,
        lastName:  dto.lastName,
        birthDate: new Date(dto.birthDate),
        sex:       dto.sex,
        curp:      dto.curp,
        phone:     dto.phone,
      },
    })
  }

  // U4.2A-FIX-2 — mirrors create()'s existing `new Date(dto.birthDate)`
  // convention, which update() was missing entirely (it previously passed
  // the raw "YYYY-MM-DD" string straight through to Prisma for a
  // DateTime/@db.Date column). `birthDate` is destructured out first so
  // `rest` never carries the raw string — only converted and re-added when
  // actually present, preserving UpdatePatientDto's optional semantics
  // (omitted → don't touch the column; the same `...rest` spread already
  // passes `curp: null`/`phone: null` straight through unchanged when the
  // doctor explicitly clears them).
  async update(id: string, dto: UpdatePatientDtoType) {
    const { birthDate, ...rest } = dto
    return prisma.paciente.update({
      where: { id },
      data: {
        ...rest,
        ...(birthDate !== undefined && { birthDate: new Date(birthDate) }),
      },
    })
  }

  async deactivate(id: string) {
    return prisma.paciente.update({ where: { id }, data: { isActive: false } })
  }

  async getHistory(patientId: string, from?: string, to?: string) {
    const dateFilter = from || to ? {
      recordedAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to   ? { lte: new Date(to)   } : {}),
      },
    } : {}

    const [records, predictions] = await prisma.$transaction([
      prisma.healthRecord.findMany({
        where: { patientId, ...dateFilter },
        orderBy: { recordedAt: 'desc' },
      }),
      prisma.prediction.findMany({
        where: { patientId },
        orderBy: { predictedAt: 'desc' },
        take: 20,
      }),
    ])

    return { records, predictions }
  }
}
