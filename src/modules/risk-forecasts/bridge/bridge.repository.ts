// NEW S2C — RForecastBridgeState persistence (decisive raw-SQL paths only).
//
// No producer other than the REAL prediction transaction (prediction.service
// → captureBridgeIfIndividualized). No backfill. Reads never touch
// personalizationProvenance or any risk score.
import { randomUUID } from 'crypto'
import { prisma } from '@/config/prisma'
import type { Prisma } from '@prisma/client'
import { BRIDGE_VERSION } from './bridge.constants'
import { float8FromBigEndianBytes, float8ToText } from './bridge.float8'

type RawClient = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>

export interface BridgeInsert {
  predictionId:           string
  healthRecordId:         string
  patientId:              string
  personalizationVersion: string
  modelVersion:           string
  sexUsed:                number
  anchorAge:              number
  appliedLogit:           number   // typed decisive value of THIS REAL R execution
}

export interface TypedBridgeState {
  id:                     string
  predictionId:           string
  healthRecordId:         string
  patientId:              string
  personalizationVersion: string
  modelVersion:           string
  sexUsed:                number
  anchorAge:              number
  status:                 'INDIVIDUALIZED'
  appliedLogit:           number   // decoded from float8send bytes (bit-exact)
  bridgeVersion:          string
  typedReadBitExact:      boolean  // diagnostic: driver's float8 value === decoded bytes
}

export async function insertBridgeState(client: RawClient, b: BridgeInsert): Promise<string> {
  const id = randomUUID()
  await client.$executeRaw`
    INSERT INTO "r_forecast_bridge_states"
      ("id", "prediction_id", "health_record_id", "patient_id", "personalization_version",
       "model_version", "sex_used", "anchor_age", "status", "applied_logit", "bridge_version")
    VALUES (${id}, ${b.predictionId}, ${b.healthRecordId}, ${b.patientId}, ${b.personalizationVersion},
            ${b.modelVersion}, ${b.sexUsed}::int, ${b.anchorAge}::int, 'INDIVIDUALIZED'::"RForecastBridgeStatus",
            ${float8ToText(b.appliedLogit)}::text::float8, ${BRIDGE_VERSION})`
  return id
}

type RawRow = {
  id: string; prediction_id: string; health_record_id: string; patient_id: string
  personalization_version: string; model_version: string; sex_used: number; anchor_age: number
  status: string; applied_logit: number; applied_logit_bits: Uint8Array; bridge_version: string
}

function toTyped(r: RawRow): TypedBridgeState {
  const decoded = float8FromBigEndianBytes(new Uint8Array(r.applied_logit_bits))
  return {
    id: r.id, predictionId: r.prediction_id, healthRecordId: r.health_record_id, patientId: r.patient_id,
    personalizationVersion: r.personalization_version, modelVersion: r.model_version,
    sexUsed: Number(r.sex_used), anchorAge: Number(r.anchor_age), status: 'INDIVIDUALIZED',
    appliedLogit: decoded, bridgeVersion: r.bridge_version,
    typedReadBitExact: Object.is(Number(r.applied_logit), decoded),
  }
}

export async function findBridgeStateByPrediction(predictionId: string, client: RawClient = prisma): Promise<TypedBridgeState | null> {
  const rows = await client.$queryRaw<RawRow[]>`
    SELECT "id", "prediction_id", "health_record_id", "patient_id", "personalization_version", "model_version",
           "sex_used", "anchor_age", "status"::text AS "status", "applied_logit",
           float8send("applied_logit") AS "applied_logit_bits", "bridge_version"
      FROM "r_forecast_bridge_states" WHERE "prediction_id" = ${predictionId}`
  return rows.length ? toTyped(rows[0]) : null
}

// Canonical bridge for an S anchor record: the bridge (if any) of the
// CANONICAL NEW-R Prediction of that record = the latest NEW-R Prediction by
// (predicted_at DESC, id DESC) — the ordering the prediction repositories use
// for "latest". A bridge of an older, superseded re-prediction is never
// returned: if the canonical Prediction is not INDIVIDUALIZED, there is no
// bridge. Selects identity/status only — never scores or provenance.
export interface CanonicalBridgeCandidate {
  canonicalPredictionId: string | null
  bridge:                TypedBridgeState | null
}

export async function findCanonicalBridgeForAnchor(
  patientId: string, healthRecordId: string, client: RawClient = prisma,
): Promise<CanonicalBridgeCandidate> {
  const preds = await client.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "predictions"
     WHERE "patient_id" = ${patientId} AND "health_record_id" = ${healthRecordId}
       AND "personalization_status" IS NOT NULL
     ORDER BY "predicted_at" DESC, "id" DESC
     LIMIT 1`
  if (!preds.length) return { canonicalPredictionId: null, bridge: null }
  return { canonicalPredictionId: preds[0].id, bridge: await findBridgeStateByPrediction(preds[0].id, client) }
}
