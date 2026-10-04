// NEW S2C-FIX1 — post-commit persistence verification for the REAL
// prediction transaction.
//
// Root cause (Angel's native evidence): an interactive prisma.$transaction()
// may RESOLVE although PostgreSQL rolled the transaction back at COMMIT
// (e.g. a deferred constraint failure). PostgreSQL's rollback is correct and
// atomic; only the success signal is false. So, after $transaction resolves
// and BEFORE any success effect (response, sockets, future S triggers), the
// committed state is re-read OUTSIDE the transaction by EXACT ids:
//
//   V1  Prediction(id) exists with the expected patientId + healthRecordId
//   V2  if an Alert was created: Alert(id) exists and references the Prediction
//   V3  if a bridge was created: exactly one RForecastBridgeState for the
//       Prediction, with the expected identity and versions
//       (GLOBAL_* outcomes create no bridge and require none)
//
// Existence + identity is the commit marker; rounded scores and the decisive
// appliedLogit are deliberately not re-compared here. Never "latest" queries,
// never provenance JSON, never the in-memory transaction result as evidence.
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'
import { TransactionCommitVerificationError } from '@/lib/errors'

export interface ExpectedPredictionCommit {
  predictionId:   string
  patientId:      string
  healthRecordId: string
  alertId:        string | null           // null ⇒ no Alert was created ⇒ none required
  bridge: null | {                         // null ⇒ no bridge expected (GLOBAL_* outcome)
    bridgeId:               string
    personalizationVersion: string
    modelVersion:           string
    bridgeVersion:          string
  }
}

type BridgeIdentityRow = {
  id: string; prediction_id: string; health_record_id: string; patient_id: string
  personalization_version: string; model_version: string; bridge_version: string
}

// Throws TransactionCommitVerificationError(<failed invariant>) — nothing else.
export async function verifyPredictionCommitted(e: ExpectedPredictionCommit, client: typeof prisma = prisma): Promise<void> {
  const fail = (invariant: string): never => {
    // No PII: ids and the failed invariant only.
    logger.error('Prediction transaction resolved but committed state is not visible', {
      code: 'TRANSACTION_COMMIT_NOT_VISIBLE', invariant, predictionId: e.predictionId,
    })
    throw new TransactionCommitVerificationError(invariant)
  }

  // V1 — Prediction
  const p = await client.prediction.findUnique({
    where: { id: e.predictionId }, select: { id: true, patientId: true, healthRecordId: true },
  })
  if (!p) fail('V1_PREDICTION_MISSING')
  if (p!.patientId !== e.patientId || p!.healthRecordId !== e.healthRecordId) fail('V1_PREDICTION_IDENTITY')

  // V2 — Alert (only when one was created in the transaction)
  if (e.alertId !== null) {
    const a = await client.alert.findUnique({ where: { id: e.alertId }, select: { id: true, predictionId: true, patientId: true } })
    if (!a) fail('V2_ALERT_MISSING')
    if (a!.predictionId !== e.predictionId || a!.patientId !== e.patientId) fail('V2_ALERT_IDENTITY')
  }

  // V3 — typed bridge (only when one was created in the transaction)
  if (e.bridge !== null) {
    const rows = await (client as any).$queryRaw`
      SELECT "id", "prediction_id", "health_record_id", "patient_id",
             "personalization_version", "model_version", "bridge_version"
        FROM "r_forecast_bridge_states" WHERE "prediction_id" = ${e.predictionId}` as BridgeIdentityRow[]
    if (rows.length !== 1) fail(rows.length === 0 ? 'V3_BRIDGE_MISSING' : 'V3_BRIDGE_NOT_UNIQUE')
    const b = rows[0]
    if (b.id !== e.bridge.bridgeId || b.health_record_id !== e.healthRecordId || b.patient_id !== e.patientId ||
        b.personalization_version !== e.bridge.personalizationVersion || b.model_version !== e.bridge.modelVersion ||
        b.bridge_version !== e.bridge.bridgeVersion) {
      fail('V3_BRIDGE_IDENTITY')
    }
  }
}
