// NEW R (R4F) — the ONE public serialization policy for Prediction rows.
//
// Every REST surface that returns Prediction objects goes through these
// mappers instead of returning raw Prisma rows, so a new column can never
// leak just because Prisma selects it by default. ALLOWLIST, not deny-list.
//
// Frozen semantics (R3 / R4E):
//   riskScore / riskLevel  = FINAL result (individualized, or exactly the
//                            global result on any GLOBAL_* fallback, or the
//                            stored score of a legacy row)
//   globalRiskScore        = GLOBAL Skorp score before personalization
//   modelVersion           = GLOBAL model version
//   personalizationStatus  = persisted NEW-R status, never inferred from
//                            whether the scores differ (γ = 0 can be
//                            INDIVIDUALIZED with riskScore == globalRiskScore)
//   personalizationVersion = e.g. "R-BPBC-3" (historical rows may remain R-BPBC-2)
//
// Legacy rows (personalizationStatus NULL) serialize as:
//   globalRiskScore = riskScore, personalizationStatus/Version = null,
//   personalizationProvenance = null — serialization only, never written back.
//
// Exposure:
//   sexUsed                    → NEVER (internal π-comparability provenance)
//   personalizationProvenance  → DETAIL surfaces only (POST result, GET /:id);
//                                audit metadata, not a statement of accuracy
//                                or confidence. Never on list/bulk surfaces.
import type { Prisma, Prediction, PersonalizationStatus, PredictionOrigin, RiskLevel } from '@prisma/client'

type Decimal = Prisma.Decimal

// Public fields common to every Prediction surface (list + detail).
export type PredictionListItem = {
  id:                     string
  patientId:              string
  healthRecordId:         string | null
  riskScore:              Decimal                    // FINAL
  riskLevel:              RiskLevel                  // FINAL
  anomalyScore:           Decimal | null             // GLOBAL
  isAnomaly:              boolean                    // GLOBAL
  modelVersion:           string | null              // GLOBAL model version
  predictedAt:            Date
  globalRiskScore:        Decimal                    // GLOBAL (legacy: = riskScore)
  personalizationStatus:  PersonalizationStatus | null
  personalizationVersion: string | null
  origin:                 PredictionOrigin           // NEW S2E-FIX3 — safe public metadata
}

// Detail = list fields + the audit provenance (still never sexUsed).
export type PredictionDetail = PredictionListItem & {
  personalizationProvenance: Prisma.JsonValue | null
}

// Relations some list surfaces already include (V7 healthRecord, U6.2 patient)
// are passed through unchanged — they are not Prediction columns.
type WithRelations<R> = (R extends { patient: infer P } ? { patient: P } : unknown)
  & (R extends { healthRecord: infer H } ? { healthRecord: H } : unknown)

function base(r: Prediction): PredictionListItem {
  const legacy = r.personalizationStatus === null
  return {
    id:                     r.id,
    patientId:              r.patientId,
    healthRecordId:         r.healthRecordId,
    riskScore:              r.riskScore,
    riskLevel:              r.riskLevel,
    anomalyScore:           r.anomalyScore,
    isAnomaly:              r.isAnomaly,
    modelVersion:           r.modelVersion,
    predictedAt:            r.predictedAt,
    // Legacy: the stored riskScore WAS the global score. NEW-R rows always
    // carry globalRiskScore (R4A CHECK); `?? riskScore` is never reached for them.
    globalRiskScore:        legacy ? r.riskScore : (r.globalRiskScore ?? r.riskScore),
    personalizationStatus:  r.personalizationStatus,
    personalizationVersion: legacy ? null : r.personalizationVersion,
    origin:                 r.origin,
  }
}

function relations(r: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('patient' in r) out.patient = (r as { patient: unknown }).patient
  if ('healthRecord' in r) out.healthRecord = (r as { healthRecord: unknown }).healthRecord
  return out
}

/** List / history / bulk surfaces: no provenance, no sexUsed. */
export function toPredictionListItem<R extends Prediction>(r: R): PredictionListItem & WithRelations<R> {
  return { ...base(r), ...relations(r) } as PredictionListItem & WithRelations<R>
}

/** Detail surfaces (POST result, GET /predictions/:id): + provenance, no sexUsed. */
export function toPredictionDetail(r: Prediction): PredictionDetail {
  return {
    ...base(r),
    personalizationProvenance: r.personalizationStatus === null ? null : r.personalizationProvenance,
  }
}
