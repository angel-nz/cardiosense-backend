import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError, ModelIneligibleError } from '@/lib/errors'
import { callAIPredict, getModelCapabilities, isAgeEligible } from '@/lib/aiClient'
import { PredictionRepository } from './prediction.repository'
import { HealthRecordRepository } from '@/modules/health-records/record.repository'
import { AlertService } from '@/modules/alerts/alert.service'
import { paginate } from '@/types'
import type { RiskLevel } from '@prisma/client'
import type { CreatePredictionDtoType, GlobalPredictionQueryDtoType, PatientPredictionQueryDtoType } from './prediction.dto'
import type { Server as IOServer } from 'socket.io'

const repo       = new PredictionRepository()
const recordRepo = new HealthRecordRepository()

export class PredictionService {
  constructor(private readonly io?: IOServer) {}

  async predict(userId: string, dto: CreatePredictionDtoType) {
    const medico = await this.getMedicoOrThrow(userId)

    // Verify patient ownership
    const patient = await prisma.paciente.findFirst({
      where: { id: dto.patientId, medicoId: medico.id },
    })
    if (!patient) throw new NotFoundError('Patient')

    // Get the health record to use
    let record
    if (dto.healthRecordId) {
      record = await recordRepo.findById(dto.healthRecordId)
    } else {
      record = await recordRepo.findLatestByPatient(dto.patientId)
    }
    if (!record) throw new NotFoundError('Health record — please create one first')

    // U8.6B — model eligibility gate (shared by manual POST /predictions and
    // the automatic prediction after record creation). Uses the persisted,
    // backend-derived record.age and the range owned by the model artifact.
    // Ineligible → no AI call, no Prediction, no Alert, no realtime events.
    const capabilities = await getModelCapabilities()
    if (!isAgeEligible(record.age, capabilities)) {
      const { min, max } = capabilities.eligibleAgeRange
      throw new ModelIneligibleError(
        `Prediction unavailable: ${capabilities.modelVersion} does not support age ${record.age} ` +
        `(observed model age support: ${min}-${max})`,
        capabilities.modelVersion,
        capabilities.eligibleAgeRange,
      )
    }

    // Call AI service
    // U4.2B — patient.sex (already fetched above for ownership, 0=female/
    // 1=male, same encoding the AI service expects) replaces the previous
    // hardcoded 0. Applies to every new prediction from here on — never
    // touches any already-persisted Prediction row.
    const aiResult = await callAIPredict(record, patient.sex)

    // Map risk level string → Prisma enum
    const riskLevelMap: Record<string, RiskLevel> = {
      low:      'LOW',
      moderate: 'MODERATE',
      high:     'HIGH',
    }
    const riskLevel = riskLevelMap[aiResult.risk_level] ?? 'LOW'

    // Persist prediction
    const prediction = await repo.create({
      patientId:     dto.patientId,
      healthRecordId: record.id,
      riskScore:     aiResult.risk_score,
      riskLevel,
      anomalyScore:  aiResult.anomaly_score,
      isAnomaly:     aiResult.is_anomaly,
      modelVersion:  aiResult.model_version,
    })

    // Create alert when high risk or anomaly
    const alertSvc = new AlertService(this.io)
    if (riskLevel === 'HIGH' || aiResult.is_anomaly) {
      const severity = riskLevel === 'HIGH' ? 'CRITICAL' : 'WARNING'
      const scorePercent = (aiResult.risk_score * 100).toFixed(1)
      const message = riskLevel === 'HIGH'
        ? `Riesgo cardiovascular alto detectado (${scorePercent}%). Requiere atención inmediata.`
        : `Anomalía detectada en indicadores de salud (score: ${aiResult.anomaly_score.toFixed(4)}).`

      await alertSvc.create({
        patientId:    dto.patientId,
        predictionId: prediction.id,
        severity,
        message,
        medicoUserId: userId,
        patientName:  `${patient.firstName} ${patient.lastName}`,
        riskScore:    aiResult.risk_score,
      })
    } else if (riskLevel === 'MODERATE') {
      await alertSvc.create({
        patientId:    dto.patientId,
        predictionId: prediction.id,
        severity:     'WARNING',
        message:      `Riesgo cardiovascular moderado (${(aiResult.risk_score * 100).toFixed(1)}%). Se recomienda seguimiento.`,
        medicoUserId: userId,
        patientName:  `${patient.firstName} ${patient.lastName}`,
        riskScore:    aiResult.risk_score,
      })
    }

    // Emit Socket.IO event to patient room
    this.io?.to(`patient:${dto.patientId}`).emit('prediction_completed', {
      predictionId: prediction.id,
      patientId:    dto.patientId,
      riskScore:    aiResult.risk_score,
      riskLevel:    aiResult.risk_level,
      isAnomaly:    aiResult.is_anomaly,
    })
    // O4.2 — dashboard_activity_changed, for EVERY persisted Prediction
    // (LOW/MODERATE/HIGH, anomaly or not) — never conditioned on whether
    // an Alert was also created (O4.1 confirmed a LOW, non-anomalous
    // Prediction never creates one, so relying on new_alert alone would
    // silently miss it). eventDate uses the actually-persisted
    // predictedAt, not a fresh timestamp.
    this.io?.to(`user:${userId}`).emit('dashboard_activity_changed', {
      patientId: dto.patientId,
      eventDate: prediction.predictedAt,
    })

    return {
      ...prediction,
      featureImportance: aiResult.feature_importance,
    }
  }

  async listByPatient(userId: string, patientId: string, opts: PatientPredictionQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const patient = await prisma.paciente.findFirst({
      where: { id: patientId, medicoId: medico.id },
    })
    if (!patient) throw new NotFoundError('Patient')

    const { data, total, page, targetResolved } = await repo.findByPatient(patientId, opts)
    return { ...paginate(data, total, page, opts.limit), ...(opts.targetId !== undefined ? { targetResolved } : {}) }
  }

  async listAll(userId: string, opts: GlobalPredictionQueryDtoType) {
    const medico = await this.getMedicoOrThrow(userId)
    const { data, total } = await repo.listAll(medico.id, opts)
    return paginate(data, total, opts.page, opts.limit)
  }

  async getOne(userId: string, predictionId: string) {
    const medico = await this.getMedicoOrThrow(userId)
    const prediction = await repo.findByIdForMedico(predictionId, medico.id)
    if (!prediction) throw new NotFoundError('Prediction')
    return prediction
  }

  private async getMedicoOrThrow(userId: string) {
    const medico = await prisma.medico.findUnique({ where: { userId } })
    if (!medico) throw new ForbiddenError('Only doctors can access predictions')
    return medico
  }
}
