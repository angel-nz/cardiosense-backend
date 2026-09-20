import { prisma } from '@/config/prisma'
import type { AlertSeverity } from '@prisma/client'

export class AlertRepository {
  async create(data: {
    patientId:    string
    predictionId?: string
    severity:     AlertSeverity
    message:      string
  }) {
    return prisma.alert.create({ data })
  }

  // U7.2 — search is ONE of three OR branches (name tokens, CURP, alert
  // message), always nested under the mandatory `medicoId` predicate — a
  // foreign patient's data can never make their Alerts visible regardless
  // of which branch matches. Doctor scoping stays a top-level AND
  // predicate, never merely one arm of the search OR (section 6).
  async findByMedico(medicoId: string, opts: {
    page:      number
    limit:     number
    unread?:   boolean
    severity?: AlertSeverity
    search?:   string
  }) {
    const { page, limit, unread, severity, search } = opts
    const skip = (page - 1) * limit

    let searchOr: unknown[] | undefined
    if (search) {
      const normalized = search.replace(/\s+/g, ' ')
      const tokens = normalized.split(' ').filter(Boolean)
      const curpCandidate = normalized.toUpperCase()
      searchOr = [
        {
          patient: {
            AND: tokens.map(token => ({
              OR: [
                { firstName: { contains: token, mode: 'insensitive' as const } },
                { lastName:  { contains: token, mode: 'insensitive' as const } },
              ],
            })),
          },
        },
        { patient: { curp: { contains: curpCandidate } } },
        { message: { contains: normalized, mode: 'insensitive' as const } },
      ]
    }

    const where = {
      patient: { medicoId },
      ...(unread !== undefined && { isRead: !unread }),
      ...(severity && { severity }),
      ...(searchOr ? { OR: searchOr } : {}),
    }

    const [data, total] = await prisma.$transaction([
      prisma.alert.findMany({
        where,
        skip,
        take:    limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          patient: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.alert.count({ where }),
    ])

    const unreadCount = await prisma.alert.count({
      where: { patient: { medicoId }, isRead: false },
    })

    return { data, total, unreadCount }
  }

  async markRead(id: string) {
    return prisma.alert.update({ where: { id }, data: { isRead: true } })
  }

  async markAllRead(medicoId: string) {
    return prisma.alert.updateMany({
      where: { patient: { medicoId }, isRead: false },
      data:  { isRead: true },
    })
  }

  async findById(id: string) {
    return prisma.alert.findUnique({
      where:   { id },
      include: { patient: true },
    })
  }

  // P2 — Patient Timeline. Scoped by patientId (not medicoId — ownership
  // of the patient is already verified by the caller before this runs,
  // same pattern as HealthRecordRepository/PredictionRepository above),
  // same [from, to) filter and asc+id ordering.
  async findInRangeForPatient(patientId: string, from?: Date, to?: Date) {
    return prisma.alert.findMany({
      where: {
        patientId,
        ...(from || to ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  }
}
