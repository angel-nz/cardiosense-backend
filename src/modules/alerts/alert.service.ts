import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError } from '@/lib/errors'
import { AlertRepository } from './alert.repository'
import { paginate } from '@/types'
import type { AlertSeverity } from '@prisma/client'
import type { AlertQueryDtoType } from './alert.dto'
import type { Server as IOServer } from 'socket.io'

const repo = new AlertRepository()

export class AlertService {
  constructor(private readonly io?: IOServer) {}

  async create(data: {
    patientId:    string
    predictionId: string
    severity:     string
    message:      string
    medicoUserId: string
    patientName:  string
    riskScore:    number
  }) {
    const alert = await repo.create({
      patientId:    data.patientId,
      predictionId: data.predictionId,
      severity:     data.severity as AlertSeverity,
      message:      data.message,
    })

    // Emit Socket.IO to doctor's room
    this.io?.to(`user:${data.medicoUserId}`).emit('new_alert', {
      id:          alert.id,
      patientId:   data.patientId,
      patientName: data.patientName,
      severity:    data.severity.toLowerCase(),
      message:     data.message,
      riskScore:   data.riskScore,
      createdAt:   alert.createdAt,
    })

    return alert
  }

  async list(userId: string, query: AlertQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const { data, total, unreadCount } = await repo.findByMedico(medico.id, {
      page:     query.page,
      limit:    query.limit,
      unread:   query.unread,
      severity: query.severity as AlertSeverity | undefined,
    })
    return {
      ...paginate(data, total, query.page, query.limit),
      unreadCount,
    }
  }

  async markRead(userId: string, alertId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    const alert  = await repo.findById(alertId)
    if (!alert) throw new NotFoundError('Alert')

    // Verify alert belongs to this medico's patient
    const patient = await prisma.paciente.findFirst({
      where: { id: alert.patientId, medicoId: medico.id },
    })
    if (!patient) throw new ForbiddenError('Alert not accessible')

    return repo.markRead(alertId)
  }

  async markAllRead(userId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    await repo.markAllRead(medico.id)
    return { success: true }
  }

  private async getMedicoOrThrow(userId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access alerts')
    return medico
  }
}
