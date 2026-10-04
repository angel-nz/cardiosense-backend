// NEW S2C — pure bridge compatibility evaluation (S1-FIX1 §2–§3, A1 = B).
//
// Ordinary incompatibility is NOT an error: it yields GLOBAL forecast scoring
// with a stable machine-readable reason. Checks run in a fixed order and the
// first failure wins:
//   B1 bridge exists                                   BRIDGE_MISSING
//   B2 patient / S-anchor / canonical prediction       BRIDGE_ANCHOR_MISMATCH
//      (+ defensive typed-state sanity)                BRIDGE_STATE_INVALID
//   B3 versions                                        BRIDGE_MODEL_VERSION_MISMATCH
//                                                      BRIDGE_PERSONALIZATION_VERSION_MISMATCH
//                                                      BRIDGE_VERSION_MISMATCH
//   B4 sex                                             BRIDGE_SEX_MISMATCH
//   B5 anchor age (CURRENT birthDate, anchor day)      BRIDGE_AGE_MISMATCH
//   B6 R entry-time axis                               R_TIME_AXIS_MISMATCH
// Nothing here recomputes R or reads provenance.
import { effectiveClinicalInstant, localClinicalDay } from '../domain/clinicalTime'
import { ageOnDate } from '../domain/simulation'
import type { SRealRecordInput } from '../domain/types'
import { BRIDGE_VERSION } from './bridge.constants'
import type { CanonicalBridgeCandidate } from './bridge.repository'

export type BridgeIncompatibilityReason =
  | 'BRIDGE_MISSING'
  | 'BRIDGE_ANCHOR_MISMATCH'
  | 'BRIDGE_STATE_INVALID'
  | 'BRIDGE_MODEL_VERSION_MISMATCH'
  | 'BRIDGE_PERSONALIZATION_VERSION_MISMATCH'
  | 'BRIDGE_VERSION_MISMATCH'
  | 'BRIDGE_SEX_MISMATCH'
  | 'BRIDGE_AGE_MISMATCH'
  | 'R_TIME_AXIS_MISMATCH'

export type BridgeCompatibility =
  | { compatible: true; bridgeStateId: string; appliedLogit: number; interpretation: 'INDIVIDUALIZED_BRIDGE' }
  | { compatible: false; reason: BridgeIncompatibilityReason; interpretation: 'GLOBAL' }

export interface BridgeCompatibilityInput {
  patient:                        { patientId: string; birthDate: string; sex: number }   // CURRENT values
  anchor:                         SRealRecordInput                                      // the S plan anchor
  records:                        readonly SRealRecordInput[]                           // ALL REAL records of the patient
  currentModelVersion:            string
  expectedPersonalizationVersion: string
  expectedBridgeVersion?:         string
  candidate:                      CanonicalBridgeCandidate | null
}

const no = (reason: BridgeIncompatibilityReason): BridgeCompatibility => ({ compatible: false, reason, interpretation: 'GLOBAL' })

export function evaluateBridgeCompatibility(i: BridgeCompatibilityInput): BridgeCompatibility {
  const b = i.candidate?.bridge ?? null
  // B1
  if (!b) return no('BRIDGE_MISSING')
  // B2 — identity: same patient, same S anchor record, and it is the bridge of
  // the CANONICAL NEW-R Prediction of that record (never an obsolete one).
  if (b.patientId !== i.patient.patientId || b.healthRecordId !== i.anchor.id ||
      !i.candidate?.canonicalPredictionId || b.predictionId !== i.candidate.canonicalPredictionId) {
    return no('BRIDGE_ANCHOR_MISMATCH')
  }
  if (b.status !== 'INDIVIDUALIZED' || typeof b.appliedLogit !== 'number' || !Number.isFinite(b.appliedLogit)) {
    return no('BRIDGE_STATE_INVALID')
  }
  // B3 — versions
  if (b.modelVersion !== i.currentModelVersion) return no('BRIDGE_MODEL_VERSION_MISMATCH')
  if (b.personalizationVersion !== i.expectedPersonalizationVersion) return no('BRIDGE_PERSONALIZATION_VERSION_MISMATCH')
  if (b.bridgeVersion !== (i.expectedBridgeVersion ?? BRIDGE_VERSION)) return no('BRIDGE_VERSION_MISMATCH')
  // B4 — sex
  if (b.sexUsed !== i.patient.sex) return no('BRIDGE_SEX_MISMATCH')
  // B5 — anchor age recomputed from the CURRENT birthDate on the anchor's
  // Guadalajara clinical day (detects a birthDate edit after capture).
  const anchorDay = localClinicalDay(effectiveClinicalInstant(i.anchor))
  if (b.anchorAge !== ageOnDate(i.patient.birthDate, anchorDay)) return no('BRIDGE_AGE_MISMATCH')
  // B6 — the S anchor must also be the latest REAL record on R's entry-time
  // axis. R4B's evidence for the anchor contains only records with
  // recordedAt STRICTLY before it, so ANY other REAL record entered at or
  // after the anchor's recordedAt (a later-entered back-dated record, or an
  // exact entry-time tie) is information the R state never saw.
  const aMs = i.anchor.recordedAt.getTime()
  if (!i.records.some(r => r.id === i.anchor.id)) return no('BRIDGE_ANCHOR_MISMATCH')
  if (i.records.some(r => r.id !== i.anchor.id && r.recordedAt.getTime() >= aMs)) return no('R_TIME_AXIS_MISMATCH')
  return { compatible: true, bridgeStateId: b.id, appliedLogit: b.appliedLogit, interpretation: 'INDIVIDUALIZED_BRIDGE' }
}
