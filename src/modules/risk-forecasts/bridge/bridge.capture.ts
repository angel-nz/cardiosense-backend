// NEW S2C — bridge capture rule, called INSIDE the REAL prediction
// transaction (prediction.service.ts) right after the Prediction (and its
// optional Alert) are created. Additive only: it reads the already-resolved
// R outcome and never changes it.
//
// Captured only for an INDIVIDUALIZED outcome with a finite typed
// appliedLogit, a known personalization version, model version, binary
// sexUsed and an integer anchor age. Any GLOBAL_* outcome → no bridge.
import type { Prisma } from '@prisma/client'
import { insertBridgeState } from './bridge.repository'

export interface BridgeCaptureInput {
  personalizationStatus:  string
  bridgeAppliedLogit:     number | null   // typed decisive value from THIS REAL R execution
  personalizationVersion: string
  modelVersion:           string
  sexUsed:                number
  anchorAge:              number
  predictionId:           string
  healthRecordId:         string
  patientId:              string
}

export function shouldCaptureBridge(i: BridgeCaptureInput): i is BridgeCaptureInput & { bridgeAppliedLogit: number } {
  return i.personalizationStatus === 'INDIVIDUALIZED'
    && typeof i.bridgeAppliedLogit === 'number' && Number.isFinite(i.bridgeAppliedLogit)
    && typeof i.personalizationVersion === 'string' && i.personalizationVersion.length > 0
    && typeof i.modelVersion === 'string' && i.modelVersion.trim().length > 0
    && (i.sexUsed === 0 || i.sexUsed === 1)
    && Number.isInteger(i.anchorAge)
}

export async function captureBridgeIfIndividualized(
  tx: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, i: BridgeCaptureInput,
): Promise<string | null> {
  if (!shouldCaptureBridge(i)) return null
  return insertBridgeState(tx, {
    predictionId: i.predictionId, healthRecordId: i.healthRecordId, patientId: i.patientId,
    personalizationVersion: i.personalizationVersion, modelVersion: i.modelVersion,
    sexUsed: i.sexUsed, anchorAge: i.anchorAge, appliedLogit: i.bridgeAppliedLogit,
  })
}
