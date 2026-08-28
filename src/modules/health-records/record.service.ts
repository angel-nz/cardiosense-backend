import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError } from '@/lib/errors'
import { HealthRecordRepository } from './record.repository'
import type { CreateRecordDtoType } from './record.dto'
import type { Server as IOServer } from 'socket.io'

const repo = new HealthRecordRepository()

export class HealthRecordService {
  constructor(private readonly io?: IOServer) {}

  // INT-20 — health_record_created. Real contract (new — no prior emission
  // existed for this module): room `patient:{patientId}`, same room as
  // subscribe_patient/unsubscribe_patient (INT-16/17) and prediction_completed
  // (INT-19). Minimal payload (ids + recordedAt), matching the lean style
  // already used by prediction_completed — NOT the full record, so the
  // frontend must refetch via the existing recordService rather than
  // fabricate missing fields client-side.
  async create(userId: string, dto: CreateRecordDtoType) {
    // Verify patient belongs to this doctor
    await this.assertPatientOwnership(userId, dto.patientId)
    const record = await repo.create(userId, dto)
    this.io?.to(`patient:${record.patientId}`).emit('health_record_created', {
      recordId:   record.id,
      patientId:  record.patientId,
      recordedAt: record.recordedAt,
    })
    return record
  }

  async listByPatient(userId: string, patientId: string, limit: number) {
    await this.assertPatientOwnership(userId, patientId)
    return repo.findByPatient(patientId, limit)
  }

  async getOne(userId: string, recordId: string) {
    const record = await repo.findById(recordId)
    if (!record) throw new NotFoundError('Health record')
    await this.assertPatientOwnership(userId, record.patientId)
    return record
  }

  async getLatest(patientId: string) {
    return repo.findLatestByPatient(patientId)
  }

  private async assertPatientOwnership(userId: string, patientId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access health records')

    const patient = await prisma.paciente.findFirst({
      where: { id: patientId, medicoId: medico.id },
    })
    if (!patient) throw new NotFoundError('Patient')
  }
}
