import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError } from '@/lib/errors'
import { PatientRepository } from './patient.repository'
import { paginate } from '@/types'
import type { CreatePatientDtoType, UpdatePatientDtoType, PatientQueryDtoType } from './patient.dto'
import type { Server as IOServer } from 'socket.io'

const repo = new PatientRepository()

export class PatientService {
  constructor(private readonly io?: IOServer) {}

  async list(userId: string, query: PatientQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const { data, total } = await repo.findAll(medico.id, {
      page:   query.page,
      limit:  query.limit,
      search: query.search,
    })
    return paginate(data, total, query.page, query.limit)
  }

  async getOne(userId: string, patientId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    const patient = await repo.findById(patientId, medico.id)
    if (!patient) throw new NotFoundError('Patient')
    return patient
  }

  async create(userId: string, dto: CreatePatientDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    return repo.create(medico.id, dto)
  }

  // INT-21 — patient_updated. Real contract: emitted only here and in
  // deactivate() below (the two places a Paciente row actually changes),
  // to room `patient:{patientId}` — same room as subscribe_patient/
  // unsubscribe_patient (INT-16/17) and prediction_completed (INT-19).
  // Never touches `user:{userId}` (that room is exclusively for new_alert).
  async update(userId: string, patientId: string, dto: UpdatePatientDtoType) {
    await this.getOne(userId, patientId)
    const patient = await repo.update(patientId, dto)
    this.emitPatientUpdated(patient)
    return patient
  }

  async deactivate(userId: string, patientId: string) {
    await this.getOne(userId, patientId)
    const patient = await repo.deactivate(patientId)
    this.emitPatientUpdated(patient)
    return patient
  }

  async getHistory(userId: string, patientId: string, from?: string, to?: string) {
    await this.getOne(userId, patientId)
    return repo.getHistory(patientId, from, to)
  }

  private emitPatientUpdated(patient: { id: string; firstName: string; lastName: string; isActive: boolean }) {
    this.io?.to(`patient:${patient.id}`).emit('patient_updated', {
      patientId: patient.id,
      firstName: patient.firstName,
      lastName:  patient.lastName,
      isActive:  patient.isActive,
    })
  }

  private async getMedicoOrThrow(userId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access patients')
    return medico
  }
}
