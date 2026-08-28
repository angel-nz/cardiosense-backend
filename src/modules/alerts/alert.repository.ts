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

  async findByMedico(medicoId: string, opts: {
    page:      number
    limit:     number
    unread?:   boolean
    severity?: AlertSeverity
  }) {
    const { page, limit, unread, severity } = opts
    const skip = (page - 1) * limit

    const where = {
      patient: { medicoId },
      ...(unread !== undefined && { isRead: !unread }),
      ...(severity && { severity }),
    }

    const [data, total] = await prisma.$transaction([
      prisma.alert.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
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
}
