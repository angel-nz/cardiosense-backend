import { prisma } from '@/config/prisma'
import { NotFoundError, ForbiddenError, ModelIneligibleError, PatientInactiveError } from '@/lib/errors'
import { callAIPredict, getModelCapabilities, isAgeEligible, type AIPersonalizationRequest } from '@/lib/aiClient'
import { PredictionRepository } from './prediction.repository'
import { HealthRecordRepository } from '@/modules/health-records/record.repository'
import { AlertService } from '@/modules/alerts/alert.service'
import { PersonalizationEvidenceService } from './personalization/evidence.service'
import { toPersonalizationRequest, type PersonalizationEvidence } from './personalization/evidence.builder'
import { resolvePersonalizationOutcome, toPrismaRiskLevel } from './personalization/personalization.outcome'
import { PERSONALIZATION_VERSION } from './personalization/personalization.constants'
import { toPredictionDetail, toPredictionListItem } from './prediction.serializer'
import { logger } from '@/lib/logger'
import { paginate } from '@/types'
import { captureBridgeIfIndividualized } from '@/modules/risk-forecasts/bridge/bridge.capture'
import { BRIDGE_VERSION } from '@/modules/risk-forecasts/bridge/bridge.constants'
import { verifyPredictionCommitted } from './prediction.commit'
import { runForecastOrchestration } from '@/modules/risk-forecasts/forecast.triggers'
import type { RiskLevel } from '@prisma/client'
import type { RealtimeAlertCategory } from '@/modules/alerts/realtimeNotification'
import type { GlobalPredictionQueryDtoType, PatientPredictionQueryDtoType } from './prediction.dto'
import type { Server as IOServer } from 'socket.io'

const repo        = new PredictionRepository()
const recordRepo  = new HealthRecordRepository()
const evidenceSvc = new PersonalizationEvidenceService()

// Y4 / R4E — the pre-existing prediction-Alert rule, unchanged in branching,
// severity, message text and realtime category. R4E only fixes its INPUTS:
// risk branches use the FINAL (persisted) riskLevel/riskScore; the anomaly
// branch uses the GLOBAL isAnomaly/anomalyScore. At most one Alert.
export function decidePredictionAlert(p: {
  finalRiskLevel: RiskLevel
  finalRiskScore: number
  isAnomaly:      boolean
  anomalyScore:   number
}): { severity: 'CRITICAL' | 'WARNING'; message: string; realtimeCategory: RealtimeAlertCategory } | null {
  if (p.finalRiskLevel === 'HIGH' || p.isAnomaly) {
    const scorePercent = (p.finalRiskScore * 100).toFixed(1)
    // HIGH takes precedence over an incidental anomaly flag (CRITICAL only for HIGH).
    return p.finalRiskLevel === 'HIGH'
      ? { severity: 'CRITICAL', realtimeCategory: 'HIGH_RISK',
          message: `Riesgo cardiovascular alto detectado (${scorePercent}%). Requiere atención inmediata.` }
      : { severity: 'WARNING', realtimeCategory: 'ANOMALY',
          message: `Anomalía detectada en indicadores de salud (score: ${p.anomalyScore.toFixed(4)}).` }
  }
  if (p.finalRiskLevel === 'MODERATE') {
    return { severity: 'WARNING', realtimeCategory: 'MODERATE_RISK',
      message: `Riesgo cardiovascular moderado (${(p.finalRiskScore * 100).toFixed(1)}%). Se recomienda seguimiento.` }
  }
  return null
}

// NEW S2E-FIX4 — the persisted REAL HealthRecord an automatic Prediction is
// computed from. Both ids are server-side values (the record just created).
export interface AutomaticPredictionRef {
  patientId:      string
  healthRecordId: string
}
const AUTOMATIC_PREDICTION_ORIGIN = 'AUTOMATIC_HEALTH_RECORD' as const

// NEW S4 — the partial UNIQUE index predictions_one_automatic_per_health_record
// (one AUTOMATIC Prediction per HealthRecord) rejected this insert: another
// worker/attempt already committed the record's Prediction. The rejected
// transaction rolled back (no Alert, no bridge) and NO side effect follows.
export class AutomaticPredictionAlreadyExistsError extends Error {
  constructor(public readonly healthRecordId: string) {
    super('Automatic Prediction already exists for this health record')
    this.name = 'AutomaticPredictionAlreadyExistsError'
  }
}
export function isAutomaticPredictionUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { target?: unknown } } | null
  const text = `${String(e?.message ?? '')} ${JSON.stringify(e?.meta ?? {})}`
  return (e?.code === 'P2002' || /23505|unique constraint/i.test(text)) &&
    /predictions_one_automatic_per_health_record|health_record_id/.test(text)
}

// NEW S4-FIX1 — the Prediction row is durably committed (and verified) but the
// post-COMMIT finalizer did not complete. The task must stay retryable FOR
// FINALIZATION ONLY: the next attempt finds the committed Prediction and
// re-runs the finalizer; the AI is never called again.
export class AutomaticFinalizationError extends Error {
  constructor(public readonly predictionId: string, public readonly causeType: string) {
    super('Automatic Prediction committed but post-commit finalization failed')
    this.name = 'AutomaticFinalizationError'
  }
}
// NEW S4-FIX1 — an "existing" automatic Prediction does not belong to the
// task's exact HealthRecord / patient (data invariant; never auto-repaired).
export class AutomaticPredictionMismatchError extends Error {
  constructor(public readonly predictionId: string) {
    super('Existing automatic Prediction does not match the task record/patient')
    this.name = 'AutomaticPredictionMismatchError'
  }
}

// NEW S4-FIX1 — everything the canonical finalizer needs; ALL of it is either
// a durable row or derived from one, so recovery can rebuild it without AI.
export interface AutomaticFinalizeInput {
  prediction:   { id: string; predictedAt: Date }
  // The already-committed prediction Alert (if any) and its notification plan.
  alert:        { id: string; createdAt: Date } | null
  alertPlan:    { severity: 'CRITICAL' | 'WARNING'; message: string; realtimeCategory: RealtimeAlertCategory } | null
  patient:      { id: string; firstName: string; lastName: string }
  healthRecordId: string
  doctorUserId: string
  riskScore:    number
  riskLevel:    'low' | 'moderate' | 'high'
  isAnomaly:    boolean
}

// NEW S4 — inputs of the canonical automatic-Prediction core. The patient and
// record are already resolved by the caller (HTTP-era gate below, or the
// durable worker, which deliberately does NOT re-apply the active/hidden
// gates to an ALREADY ACCEPTED record — S4 §14). `doctorUserId` is the owning
// doctor's user id (socket rooms, Alert notification).
export interface AutomaticPredictionCoreInput {
  patient:      Awaited<ReturnType<typeof prisma.patient.findFirst>> & object
  record:       NonNullable<Awaited<ReturnType<HealthRecordRepository['findByIdForPatient']>>>
  doctorUserId: string
}

export class PredictionService {
  constructor(private readonly io?: IOServer) {}

  // NEW S2E-FIX4 — the ONLY Prediction write path: predict AUTOMATICALLY from
  // ONE persisted REAL HealthRecord (called by HealthRecordService after the
  // record has committed). There is no public/manual caller any more, the
  // record is always explicit (no "latest record" fallback) and the origin is
  // fixed here — no caller can supply it. Evidence, canonicalization,
  // scoring, alerts, the S2C bridge, post-COMMIT verification and the S
  // trigger below are computed exactly as before.
  async predictFromHealthRecord(userId: string, ref: AutomaticPredictionRef) {
    const dto = ref
    const origin = AUTOMATIC_PREDICTION_ORIGIN
    const doctor = await this.getDoctorOrThrow(userId)

    // Verify patient ownership. Z8 §26/§29 — isHidden=true is excluded here
    // so a hidden patient behaves exactly like a nonexistent one (no
    // "exists but hidden" leak) for the automatic (HealthRecordService-
    // triggered) path — the only caller since S2E-FIX4.
    const patient = await prisma.patient.findFirst({
      where: { id: dto.patientId, doctorId: doctor.id, isHidden: false },
    })
    if (!patient) throw new NotFoundError('Patient')

    // Z8 §29 — required order: resolve patient -> ownership -> hidden? ->
    // active? -> resolve latest record/features -> callAIPredict. A
    // resolved-but-INACTIVE patient (isActive=false, isHidden=false —
    // otherwise the lookup above would already have thrown NotFoundError)
    // may not receive a new prediction. Thrown BEFORE record resolution and
    // well before the callAIPredict call below — critical invariant: no AI
    // request is ever made for an inactive or hidden patient.
    if (!patient.isActive) throw new PatientInactiveError()

    // Get the health record to use.
    // R1.5 — an explicit healthRecordId is resolved ONLY within the already
    // authorized patient (findByIdForPatient), never by id alone: a record
    // of another patient — even one owned by the same doctor — resolves to
    // null and is rejected with exactly the same NotFoundError as a
    // nonexistent id, so a foreign record's existence is never revealed and
    // no AI call / Prediction / Alert / socket event can follow. The
    // implicit path (latest record) was already patient-scoped.
    const record = await recordRepo.findByIdForPatient(dto.healthRecordId, patient.id)
    if (!record) throw new NotFoundError('Health record — please create one first')
    // Invariant guard (defense in depth): Prediction.patientId must always
    // equal Prediction.healthRecord.patientId. Unreachable with the scoped
    // lookups above; kept so a future change to record resolution cannot
    // silently reintroduce cross-patient predictions.
    if (record.patientId !== patient.id) throw new NotFoundError('Health record — please create one first')

    return this.scoreAndPersistAutomatic({ patient, record, doctorUserId: userId })
  }

  // NEW S4 — the ONE canonical automatic scoring + persistence core (moved
  // verbatim out of predictFromHealthRecord: eligibility, evidence, ONE AI
  // call, R outcome, atomic Prediction + Alert + bridge, S2C-FIX1 post-COMMIT
  // verification, then the post-commit side effects). R arithmetic and the
  // persisted fields are unchanged. Called by predictFromHealthRecord (gated)
  // and by the durable automatic-Prediction worker.
  async scoreAndPersistAutomatic(input: AutomaticPredictionCoreInput) {
    const { patient, record, doctorUserId: userId } = input
    const dto = { patientId: patient.id, healthRecordId: record.id }
    const origin = AUTOMATIC_PREDICTION_ORIGIN

    // U8.6B — model eligibility gate for the automatic prediction after
    // record creation. Uses the persisted,
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

    // ── NEW R (R4E) — evidence → ONE AI call → normalize → atomic persist ──
    // U4.2B — patient.sex (already fetched above for ownership, 0=female/
    // 1=male, same encoding the AI service expects). R4E: this exact value is
    // also persisted as Prediction.sexUsed — the sex actually sent to the
    // global model for THIS prediction (never inferred from the AI response,
    // never a historical value).
    const sexUsed = patient.sex
    const t0 = Date.now()

    // R4B is the SOLE backend evidence policy (cutoff, dedupe, bursts, π,
    // sex provenance, fingerprint). Inputs: the authorized patient, the
    // R1.5-scoped anchor, and the SAME capability contract (AI /health,
    // model-artifact owned) already used by the eligibility gate above — one
    // authoritative source for the global model version and eligible domain.
    // An extraction failure never blocks a valid global prediction (R3): it
    // degrades to ONE global-only AI call + GLOBAL_ERROR_FALLBACK.
    let evidence: PersonalizationEvidence | null = null
    let personalizationRequest: AIPersonalizationRequest | undefined
    try {
      evidence = await evidenceSvc.extract({
        patient,
        anchor:             record,
        globalModelVersion: capabilities.modelVersion,
        eligibleAgeRange:   capabilities.eligibleAgeRange,
      })
      personalizationRequest = toPersonalizationRequest(evidence)
    } catch (err) {
      evidence = null
      personalizationRequest = undefined
      logger.warn('Personalization evidence extraction failed — global-only AI call', {
        patientId:     patient.id,
        healthRecordId: record.id,
        errorType:     err instanceof Error ? err.name : typeof err,
      })
    }
    const tEvidence = Date.now()

    // EXACTLY ONE AI call: with the personalization block when evidence
    // exists (the AI returns global top-level + personalization from the same
    // request), otherwise the legacy global-only request. A failure to obtain
    // a VALID GLOBAL result throws here (existing semantics): no Prediction,
    // no Alert, no realtime event — never a fabricated fallback.
    const ai = await callAIPredict(record, sexUsed, personalizationRequest)
    const tAi = Date.now()

    const outcome = resolvePersonalizationOutcome({
      global:             ai.global,
      anchorMeasuredAt:   record.measuredAt,
      evidence,
      personalizationRaw: ai.personalizationRaw,
    })
    const riskLevel = toPrismaRiskLevel(outcome.finalRiskLevel)   // FINAL level (AI-classified, unrounded p_final)
    const alertPlan = decidePredictionAlert({
      finalRiskLevel: riskLevel,
      finalRiskScore: outcome.finalRiskScore,
      isAnomaly:      ai.global.isAnomaly,        // anomaly stays GLOBAL
      anomalyScore:   ai.global.anomalyScore,
    })
    const patientName = `${patient.firstName} ${patient.lastName}`
    const alertSvc = new AlertService(this.io)

    // Frozen R3 contract: Prediction + its Alert (if any) in ONE transaction.
    // No evidence extraction / AI / network I/O happens inside it. Any
    // failure rolls back both rows and NO realtime event is emitted.
    const committed = await prisma.$transaction(async tx => {
      const created = await repo.create({
        patientId:      patient.id,
        healthRecordId: record.id,
        riskScore:      outcome.finalRiskScore,
        riskLevel,
        anomalyScore:   ai.global.anomalyScore,
        isAnomaly:      ai.global.isAnomaly,
        modelVersion:   ai.global.modelVersion,
        globalRiskScore:           ai.global.riskScore,
        personalizationStatus:     outcome.status,
        personalizationVersion:    PERSONALIZATION_VERSION,
        sexUsed,
        personalizationProvenance: outcome.provenance,
        origin,
      }, tx)
      const createdAlert = alertPlan
        ? await alertSvc.persistPredictionAlert({
            patientId: patient.id, predictionId: created.id, severity: alertPlan.severity, message: alertPlan.message,
          }, tx)
        : null
      // NEW S2C — typed forecast bridge, in the SAME transaction (commits or
      // rolls back with the Prediction/Alert). Additive only: reads the
      // already-resolved outcome; INDIVIDUALIZED only; no-op otherwise.
      const createdBridgeId = await captureBridgeIfIndividualized(tx, {
        personalizationStatus:  outcome.status,
        bridgeAppliedLogit:     outcome.bridgeAppliedLogit,
        personalizationVersion: PERSONALIZATION_VERSION,
        modelVersion:           ai.global.modelVersion,
        sexUsed,
        anchorAge:              record.age,
        predictionId:           created.id,
        healthRecordId:         record.id,
        patientId:              patient.id,
      })
      return { prediction: created, alert: createdAlert, bridgeId: createdBridgeId }
    }).catch((err: unknown) => {
      // NEW S4 — another attempt already committed this record's ONE
      // automatic Prediction (partial UNIQUE index): this transaction rolled
      // back entirely; no side effect is replayed.
      if (isAutomaticPredictionUniqueViolation(err)) throw new AutomaticPredictionAlreadyExistsError(record.id)
      throw err
    })
    const { prediction, alert, bridgeId } = committed
    const tTx = Date.now()

    // NEW S2C-FIX1 — a resolved $transaction is NOT commit evidence (native
    // Prisma can resolve after a COMMIT-time rollback). Re-read the exact
    // committed state outside the transaction BEFORE any success effect
    // (log line, sockets, response). Throws TransactionCommitVerificationError
    // on absence/inconsistency — nothing below runs in that case.
    await verifyPredictionCommitted({
      predictionId:   prediction.id,
      patientId:      patient.id,
      healthRecordId: record.id,
      alertId:        alert ? alert.id : null,
      bridge: bridgeId === null ? null : {
        bridgeId,
        personalizationVersion: PERSONALIZATION_VERSION,
        modelVersion:           ai.global.modelVersion,
        bridgeVersion:          BRIDGE_VERSION,
      },
    })

    logger.info('Prediction created', {
      predictionId:           prediction.id,
      patientId:              patient.id,
      modelVersion:           ai.global.modelVersion,
      personalizationVersion: PERSONALIZATION_VERSION,
      status:                 outcome.status,
      reason:                 outcome.reason,
      effectiveUnits:         evidence ? evidence.counts.clinical.effectiveUnits : null,
      piUnits:                evidence ? evidence.counts.prediction.canonicalUnits : null,
      evidenceMs:             tEvidence - t0,
      aiMs:                   tAi - tEvidence,
      txMs:                   tTx - tAi,
    })

    // NEW S4-FIX1 — every post-COMMIT effect lives in ONE canonical,
    // idempotent (at-least-once safe) finalizer, shared with crash recovery.
    // A finalizer failure never rescored/rolled back anything: the Prediction
    // is committed, the durable task stays retryable for finalization only.
    try {
      await this.finalizeAutomaticPrediction({
        prediction:   { id: prediction.id, predictedAt: prediction.predictedAt },
        alert:        alert ? { id: alert.id, createdAt: alert.createdAt } : null,
        alertPlan,
        patient:      { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
        healthRecordId: record.id,
        doctorUserId: userId,
        riskScore:    outcome.finalRiskScore,
        riskLevel:    outcome.finalRiskLevel,
        isAnomaly:    ai.global.isAnomaly,
      })
    } catch (err) {
      throw new AutomaticFinalizationError(prediction.id, err instanceof Error ? err.name : typeof err)
    }

    // R4F — deliberate DETAIL contract (prediction.serializer.ts): FINAL
    // riskScore/riskLevel, globalRiskScore, status/version, audit provenance;
    // never sexUsed. featureImportance = GLOBAL-model importance, not persisted.
    return {
      ...toPredictionDetail(prediction),
      featureImportance: ai.global.featureImportance,
    }
  }

  // NEW S4-FIX1 — the ONE canonical post-COMMIT finalizer of an automatic
  // Prediction. Responsibilities are ONLY the accepted post-persistence
  // effects (no row is ever created here — Prediction / Alert / bridge are
  // already durable):
  //   1. Alert notification (alerts_changed / new_alert / dashboard signal)
  //      when a persisted prediction Alert exists;
  //   2. prediction_completed (patient room; payload carries the persisted
  //      predictionId — the client action is an idempotent refetch);
  //   3. dashboard_activity_changed (doctor room);
  //   4. S forecast orchestration, trigger ANCHOR_PREDICTION_PERSISTED
  //      (fingerprint-idempotent), awaited so the task completes only after
  //      the S opportunity ran.
  // AT-LEAST-ONCE: crash recovery may run it again; duplicates are harmless
  // invalidation signals / an idempotent S request. Socket.IO exactly-once
  // delivery is never promised. Each socket effect stays best-effort (an
  // emission failure never undoes committed rows — accepted pre-S4 contract).
  async finalizeAutomaticPrediction(input: AutomaticFinalizeInput): Promise<void> {
    const { prediction, alert, alertPlan, patient, doctorUserId: userId } = input
    if (alert && alertPlan) {
      try {
        await new AlertService(this.io).notifyPredictionAlertCreated(alert, {
          patientId: patient.id, predictionId: prediction.id, severity: alertPlan.severity,
          message: alertPlan.message, doctorUserId: userId, patientName: `${patient.firstName} ${patient.lastName}`,
          riskScore: input.riskScore, realtimeCategory: alertPlan.realtimeCategory,
        })
      } catch (err) {
        logger.warn('Post-commit alert notification failed — Prediction/Alert already committed', {
          predictionId: prediction.id, alertId: alert.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // W4.2 payload unchanged (predictionId already the stable identity).
    try {
      this.io?.to(`patient:${patient.id}`).emit('prediction_completed', {
        predictionId: prediction.id,
        patientId:    patient.id,
        healthRecordId: input.healthRecordId,
        riskScore:    input.riskScore,
        riskLevel:    input.riskLevel,
        isAnomaly:    input.isAnomaly,
      })
    } catch (err) {
      logger.warn('prediction_completed emit failed — Prediction already committed', {
        predictionId: prediction.id, err: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      this.io?.to(`user:${userId}`).emit('dashboard_activity_changed', {
        patientId: patient.id,
        eventDate: prediction.predictedAt,
      })
    } catch (err) {
      logger.warn('dashboard_activity_changed emit failed — Prediction already committed', {
        predictionId: prediction.id, err: err instanceof Error ? err.message : String(err),
      })
    }
    // Committed AND verified Prediction → its bridge state may change S.
    // Never rejects (failures logged in the trigger boundary); the durable
    // task is not completed until it settles.
    await runForecastOrchestration(patient.id, 'ANCHOR_PREDICTION_PERSISTED', this.io)
  }

  // NEW S4-FIX1 — recovery of an ALREADY-COMMITTED automatic Prediction
  // (crash after COMMIT, lost lease, racing worker, reconciliation). Verifies
  // ownership, rebuilds the finalizer input from durable rows ONLY (no AI, no
  // new Prediction/Alert/bridge) and runs the canonical finalizer.
  async finalizeExistingAutomaticPrediction(input: {
    patient: { id: string; firstName: string; lastName: string }
    healthRecordId: string
    predictionId: string
    doctorUserId: string
  }): Promise<void> {
    const p = await prisma.prediction.findUnique({ where: { id: input.predictionId } })
    if (!p || p.patientId !== input.patient.id || p.healthRecordId !== input.healthRecordId || p.origin !== AUTOMATIC_PREDICTION_ORIGIN) {
      throw new AutomaticPredictionMismatchError(input.predictionId)
    }
    const alertRow = await prisma.alert.findFirst({ where: { predictionId: p.id }, select: { id: true, createdAt: true, severity: true, message: true } })
    const riskScore = Number(p.riskScore)
    const plan = decidePredictionAlert({
      finalRiskLevel: p.riskLevel, finalRiskScore: riskScore, isAnomaly: p.isAnomaly,
      anomalyScore: p.anomalyScore === null ? 0 : Number(p.anomalyScore),
    })
    let alert: AutomaticFinalizeInput['alert'] = null
    let alertPlan: AutomaticFinalizeInput['alertPlan'] = null
    if (alertRow && plan && (alertRow.severity === 'CRITICAL' || alertRow.severity === 'WARNING')) {
      // Persisted severity/message are authoritative; only the realtime
      // category (a pure function of level/anomaly) is re-derived.
      alert = { id: alertRow.id, createdAt: alertRow.createdAt }
      alertPlan = { severity: alertRow.severity, message: alertRow.message, realtimeCategory: plan.realtimeCategory }
    } else if (alertRow || plan) {
      logger.warn('Automatic Prediction recovery: Alert row / plan inconsistent — Alert notification skipped (rows are never recreated)', {
        predictionId: p.id, hasAlertRow: Boolean(alertRow), hasPlan: Boolean(plan),
      })
    }
    await this.finalizeAutomaticPrediction({
      prediction: { id: p.id, predictedAt: p.predictedAt }, alert, alertPlan,
      patient: input.patient, healthRecordId: p.healthRecordId as string, doctorUserId: input.doctorUserId,
      riskScore, riskLevel: p.riskLevel.toLowerCase() as AutomaticFinalizeInput['riskLevel'], isAnomaly: p.isAnomaly,
    })
  }

  async listByPatient(userId: string, patientId: string, opts: PatientPredictionQueryDtoType) {
    const doctor = await this.getDoctorOrThrow(userId)
    // Z8 §26/§33 — read-only path: isHidden=true excluded (same as predictFromHealthRecord()
    // above), but NO isActive check — an INACTIVE_VISIBLE patient's existing
    // prediction history must remain fully browsable.
    const patient = await prisma.patient.findFirst({
      where: { id: patientId, doctorId: doctor.id, isHidden: false },
    })
    if (!patient) throw new NotFoundError('Patient')

    const { data, total, page, targetResolved } = opts.sortBy === 'clinicalTime'
      ? await repo.findByPatientClinical(patientId, opts)
      : await repo.findByPatient(patientId, opts)
    // R4F — list contract: no provenance, no sexUsed (prediction.serializer.ts).
    return { ...paginate(data.map(toPredictionListItem), total, page, opts.limit), ...(opts.targetId !== undefined ? { targetResolved } : {}) }
  }

  async listAll(userId: string, opts: GlobalPredictionQueryDtoType) {
    const doctor = await this.getDoctorOrThrow(userId)
    const { data, total } = opts.sortBy === 'clinicalTime' ? await repo.listAllClinical(doctor.id, opts) : await repo.listAll(doctor.id, opts)
    return paginate(data.map(toPredictionListItem), total, opts.page, opts.limit)
  }

  async getOne(userId: string, predictionId: string) {
    const doctor = await this.getDoctorOrThrow(userId)
    const prediction = await repo.findByIdForDoctor(predictionId, doctor.id)
    if (!prediction) throw new NotFoundError('Prediction')
    return toPredictionDetail(prediction)   // R4F detail contract
  }

  private async getDoctorOrThrow(userId: string) {
    const doctor = await prisma.doctor.findUnique({ where: { userId } })
    if (!doctor) throw new ForbiddenError('Only doctors can access predictions')
    return doctor
  }
}
