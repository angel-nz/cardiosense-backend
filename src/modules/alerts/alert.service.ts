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
    // O4.2 — dashboard_activity_changed. Redundant with the one
    // prediction.service.ts already emits when this Alert was created as
    // part of that same predict() call (the only current call site of
    // AlertService.create()) — accepted by design (O4.1): short frontend
    // coalescing absorbs the burst, and centralizing emission to avoid the
    // duplicate would couple this module to whether its caller already
    // emitted, for no real benefit.
    this.io?.to(`user:${data.medicoUserId}`).emit('dashboard_activity_changed', {
      patientId: data.patientId,
      eventDate: alert.createdAt,
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
      search:   query.search,
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
