// P2 — Patient Timeline: read-side aggregation types and pure logic.
//
// Architecture decision (D-P1-01, confirmed in P1): AGGREGATED, not
// materialized. No new Prisma model, no migration. This file only maps
// already-persisted rows (HealthRecord, Prediction, Alert) into a common
// event shape, and derives RISK_CHANGE from consecutive Predictions —
// nothing here writes to the database.

export type TimelineEventType = 'CLINICAL_RECORD' | 'PREDICTION' | 'ALERT' | 'RISK_CHANGE'

interface ClinicalRecordMetadata {
  healthRecordId: string
  sysBP: number
  diaBP: number
}

interface PredictionMetadata {
  predictionId: string
  healthRecordId: string | null
  riskScore: number
  riskLevel: string
  isAnomaly: boolean
  anomalyScore: number | null
  modelVersion: string | null
}

interface AlertMetadata {
  alertId: string
  predictionId: string | null
  severity: string
  message: string
  isRead: boolean
}

interface RiskChangeMetadata {
  fromLevel: string
  toLevel: string
  previousPredictionId: string
  currentPredictionId: string
}

export interface ClinicalRecordTimelineEvent {
  id: string
  patientId: string
  eventType: 'CLINICAL_RECORD'
  eventDate: string
  metadata: ClinicalRecordMetadata
}

export interface PredictionTimelineEvent {
  id: string
  patientId: string
  eventType: 'PREDICTION'
  eventDate: string
  metadata: PredictionMetadata
}

export interface AlertTimelineEvent {
  id: string
  patientId: string
  eventType: 'ALERT'
  eventDate: string
  metadata: AlertMetadata
}

export interface RiskChangeTimelineEvent {
  id: string
  patientId: string
  eventType: 'RISK_CHANGE'
  eventDate: string
  metadata: RiskChangeMetadata
}

export type PatientTimelineEvent =
  | ClinicalRecordTimelineEvent
  | PredictionTimelineEvent
  | AlertTimelineEvent
  | RiskChangeTimelineEvent

// ─── Source row shapes (only the fields these mappers actually read) ──────

interface HealthRecordRow {
  id: string
  patientId: string
  recordedAt: Date
  sysBP: unknown   // Prisma.Decimal at runtime
  diaBP: unknown
}

interface PredictionRow {
  id: string
  patientId: string
  healthRecordId: string | null
  predictedAt: Date
  riskScore: unknown
  riskLevel: string
  isAnomaly: boolean
  anomalyScore: unknown
  modelVersion: string | null
}

interface AlertRow {
  id: string
  patientId: string
  predictionId: string | null
  createdAt: Date
  severity: string
  message: string
  isRead: boolean
}

// ─── Mappers (P2.6 / P2.7 / P2.8) ──────────────────────────────────────────

// CLINICAL_RECORD — source: HealthRecord. Date: recordedAt (the clinical
// moment, per D-P1-06/P1.3), deliberately NOT createdAt (persistence
// moment) — both exist on the model and are numerically identical today
// (recordedAt isn't editable yet), but recordedAt is the semantically
// correct field and future-proofs against that changing. Identity: the
// HealthRecord's own id. Metadata is a summary, not the full clinical
// record (12 fields) — the timeline is not a replacement for the patient's
// existing clinical history view.
export function toClinicalRecordEvent(record: HealthRecordRow): ClinicalRecordTimelineEvent {
  return {
    id: record.id,
    patientId: record.patientId,
    eventType: 'CLINICAL_RECORD',
    eventDate: record.recordedAt.toISOString(),
    metadata: {
      healthRecordId: record.id,
      sysBP: Number(record.sysBP),
      diaBP: Number(record.diaBP),
    },
  }
}

// PREDICTION — source: Prediction. Date: predictedAt. Identity: the
// Prediction's own id. isAnomaly/anomalyScore stay as metadata on THIS
// event — never a separate ANOMALY event (P1 decision, reaffirmed by this
// prompt). healthRecordId/anomalyScore/modelVersion are nullable on the
// model itself — preserved as null here, never fabricated ("unknown",
// current Skorp version, etc.) per section 36.
export function toPredictionEvent(prediction: PredictionRow): PredictionTimelineEvent {
  return {
    id: prediction.id,
    patientId: prediction.patientId,
    eventType: 'PREDICTION',
    eventDate: prediction.predictedAt.toISOString(),
    metadata: {
      predictionId: prediction.id,
      healthRecordId: prediction.healthRecordId,
      riskScore: Number(prediction.riskScore),
      riskLevel: prediction.riskLevel,
      isAnomaly: prediction.isAnomaly,
      anomalyScore: prediction.anomalyScore == null ? null : Number(prediction.anomalyScore),
      modelVersion: prediction.modelVersion,
    },
  }
}

// ALERT — source: Alert. Date: createdAt (Alert has no other date field).
// Identity: the Alert's own id. predictionId is nullable on the model —
// the current AlertService.create() call site always supplies one, but
// this mapper respects the schema's real nullability rather than the
// service's current guarantee (section 13). No proximity-based inference
// of a missing link — never attempted here.
export function toAlertEvent(alert: AlertRow): AlertTimelineEvent {
  return {
    id: alert.id,
    patientId: alert.patientId,
    eventType: 'ALERT',
    eventDate: alert.createdAt.toISOString(),
    metadata: {
      alertId: alert.id,
      predictionId: alert.predictionId,
      severity: alert.severity,
      message: alert.message,
      isRead: alert.isRead,
    },
  }
}

// ─── RISK_CHANGE derivation (P2.9) ─────────────────────────────────────────
//
// Pure function, no DB access — deliberately isolated here so it can be
// exercised directly (see the verification performed for this block; no
// test framework exists in this backend, per section 41, so none was
// introduced).
//
// Contract:
//   - Input MUST already be sorted predictedAt ASC, with a stable
//     secondary sort by id for any exactly-equal timestamps — the caller
//     (patient.service.ts) is responsible for that ordering; this function
//     does not re-sort, so it can be reused with a sequence that may
//     legitimately start with a predecessor Prediction from before the
//     requested range (see section 19).
//   - The FIRST Prediction in the sequence never produces a RISK_CHANGE —
//     there is no "previous" to compare it to, and no level is assumed
//     for one (never "UNKNOWN → X").
//   - Compares `riskLevel` only, never `riskScore` — two Predictions with
//     different scores but the same persisted riskLevel produce no event.
//   - Uses each Prediction's `riskLevel` exactly as persisted — never
//     recomputed from riskScore/thresholds, so historical events stay
//     accurate even if thresholds or the model version change later.
export function deriveRiskChanges(
  sortedPredictions: Array<{ id: string; patientId: string; predictedAt: Date; riskLevel: string }>,
): RiskChangeTimelineEvent[] {
  const events: RiskChangeTimelineEvent[] = []
  for (let i = 1; i < sortedPredictions.length; i++) {
    const prev = sortedPredictions[i - 1]
    const curr = sortedPredictions[i]
    if (prev.riskLevel === curr.riskLevel) continue
    events.push({
      id: `risk-change:${curr.id}`,
      patientId: curr.patientId,
      eventType: 'RISK_CHANGE',
      eventDate: curr.predictedAt.toISOString(),
      metadata: {
        fromLevel: prev.riskLevel,
        toLevel: curr.riskLevel,
        previousPredictionId: prev.id,
        currentPredictionId: curr.id,
      },
    })
  }
  return events
}

// ─── Global ordering (P2.11) ───────────────────────────────────────────────
//
// eventDate ASC, tie-break by a semantic event-type priority (so a
// RISK_CHANGE — which always shares its timestamp with its own "current"
// PREDICTION — sorts immediately after that PREDICTION, giving a readable
// order, rather than an arbitrary one from comparing UUID strings), then
// by id for any still-remaining ties (e.g. two distinct real Predictions
// with an identical predictedAt).
const TYPE_PRIORITY: Record<TimelineEventType, number> = {
  CLINICAL_RECORD: 0,
  PREDICTION: 1,
  RISK_CHANGE: 2,
  ALERT: 3,
}

export function sortTimelineEvents(events: PatientTimelineEvent[]): PatientTimelineEvent[] {
  return [...events].sort((a, b) => {
    const dateDiff = new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime()
    if (dateDiff !== 0) return dateDiff
    const typeDiff = TYPE_PRIORITY[a.eventType] - TYPE_PRIORITY[b.eventType]
    if (typeDiff !== 0) return typeDiff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
