// NEW S2B — pure deterministic S forecast PLANNING (no I/O, no clock, no AI,
// no persistence, no R). Output is a PLAN for later scoring:
//
//   REAL HealthRecords → S clinical order → lifecycle gate → eligibility
//   (E1–E7) → measured visits → S-CAD-3 interval sequence (NEW S4) →
//   cumulative target dates → S-FEAT-SEQUENTIAL-ROBUST-2 states (F1 from ALL
//   usable REAL records; F2 + in-run F1; F3 + in-run F1, F2) → admissibility
//   → contiguous horizons → plan + fingerprint
// Cadence visits (measured, one per clinical day) and the feature history
// (EVERY usable REAL record, legacy via recordedAt) are separate concerns.
//
// Eligibility is independent of R activation. Inputs contain no Prediction /
// risk-score history; S never extrapolates risk.

import { CAD_MIN_VISITS, S_POLICY_VERSIONS } from './constants'
import { calendarDayDiff, effectiveClinicalInstant, localClinicalDay, sortByClinicalOrder } from './clinicalTime'
import { sCad3 } from './cadence'
import { computeInputFingerprint } from './fingerprint'
import { planSequentialHorizons } from './simulation'
import { classifyRecord } from './validity'
import {
  SInputContractError,
  type SCadenceEvidence, type SCounts, type SEligibilityReason, type SEligibilityStatus, type SEvaluatedPlan,
  type SLifecycleResult, type SPatientInput, type SPlanInput, type SPlanResult, type SRealRecordInput, type SRecordStatus,
} from './types'

export function lifecycleOf(p: SPatientInput): SLifecycleResult {
  if (p.isActive && p.isHidden) return 'PATIENT_LIFECYCLE_INVALID'
  if (p.isHidden) return 'PATIENT_HIDDEN'
  if (!p.isActive) return 'PATIENT_INACTIVE'
  return 'ACTIVE'
}

// Measured visits: REAL ∧ usable ∧ CLINICIAN_ENTERED records only, one visit
// per Guadalajara clinical day, represented by the LAST record of that day in
// S clinical order. Legacy rows never add a visit.
export function buildMeasuredVisits(
  ordered: readonly SRealRecordInput[], status: ReadonlyMap<string, SRecordStatus>,
): { visits: { day: string; record: SRealRecordInput }[]; evidence: SCadenceEvidence } {
  const byDay = new Map<string, SRealRecordInput>()
  for (const r of ordered) {
    if (r.clinicalTimeSource !== 'CLINICIAN_ENTERED' || r.measuredAt === null || status.get(r.id) !== 'USABLE') continue
    byDay.set(localClinicalDay(r.measuredAt), r)                       // ascending clinical order ⇒ last wins
  }
  const days = [...byDay.keys()].sort()                                  // YYYY-MM-DD sorts chronologically
  const visits = days.map(day => ({ day, record: byDay.get(day)! }))
  const gaps = days.slice(1).map((d, i) => calendarDayDiff(days[i], d))
  return { visits, evidence: { visitDays: days, gaps } }
}

function validateModel(input: SPlanInput): void {
  const { min, max } = input.model.eligibleAgeRange
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new SInputContractError(`invalid model eligible age range ${min}..${max}`)
  }
  if (!input.model.modelVersion) throw new SInputContractError('model version required')
}

export function planForecast(input: SPlanInput): SPlanResult {
  validateModel(input)
  const policies = { ...S_POLICY_VERSIONS }
  const model = { modelVersion: input.model.modelVersion, eligibleAgeRange: { ...input.model.eligibleAgeRange } }
  const ordered = sortByClinicalOrder(input.records)          // validates the S2A time invariant too
  const inputFingerprint = computeInputFingerprint(input)

  const lifecycle = lifecycleOf(input.patient)
  if (lifecycle !== 'ACTIVE') return { kind: 'LIFECYCLE_GATED', lifecycle, policies, model, inputFingerprint }

  // ── classification + counts ────────────────────────────────────────────
  const status = new Map<string, SRecordStatus>()
  for (const r of ordered) status.set(r.id, classifyRecord(r, input.patient.sex, model).status)
  const count = (pred: (r: SRealRecordInput) => boolean) => ordered.filter(pred).length
  const counts: SCounts = {
    totalRealRecordCount:              ordered.length,
    usableRecordCount:                 count(r => status.get(r.id) === 'USABLE'),
    invalidRecordCount:                count(r => status.get(r.id) === 'INVALID'),
    outOfModelDomainCount:             count(r => status.get(r.id) === 'OUT_OF_MODEL_DOMAIN'),
    legacyRecordCount:                 count(r => r.clinicalTimeSource === 'LEGACY_ENTRY_TIME'),
    clinicianEnteredRecordCount:       count(r => r.clinicalTimeSource === 'CLINICIAN_ENTERED'),
    clinicianEnteredUsableRecordCount: count(r => r.clinicalTimeSource === 'CLINICIAN_ENTERED' && status.get(r.id) === 'USABLE'),
    measuredVisitCount:                0,
    positiveGapCount:                  0,
  }
  const base = { kind: 'EVALUATED' as const, lifecycle: 'ACTIVE' as const, counts, policies, model, inputFingerprint }
  const notEligible = (s: SEligibilityStatus, reason: SEligibilityReason, extra: Partial<SEvaluatedPlan> = {}): SEvaluatedPlan => ({
    ...base, eligibility: { status: s, reason }, anchor: null, cadenceEvidence: null, cadence: null, featureTrends: null,
    generation: { status: 'NOT_APPLICABLE', reason: null }, targets: [], ...extra,
  })

  // E1 — no history
  if (ordered.length === 0) return notEligible('HISTORY_ABSENT', 'NO_HEALTH_RECORDS')
  // E2 — no usable record
  if (counts.usableRecordCount === 0) return notEligible('HISTORY_INVALID', 'NO_USABLE_RECORD')
  // E3 — the latest REAL record decides; older usable rows never stand in for it
  const latest = ordered[ordered.length - 1]
  const latestStatus = status.get(latest.id)
  if (latestStatus === 'INVALID') return notEligible('HISTORY_INVALID', 'LATEST_RECORD_INVALID')
  if (latestStatus === 'OUT_OF_MODEL_DOMAIN') return notEligible('HISTORY_INVALID', 'LATEST_RECORD_OUT_OF_MODEL_DOMAIN')
  // E4 — clinical-time anchor (A2 = L-EXCLUDE-CADENCE)
  if (counts.clinicianEnteredUsableRecordCount === 0) return notEligible('CLINICAL_HISTORY_INSUFFICIENT', 'NO_MEASURED_CLINICAL_TIME')
  if (latest.clinicalTimeSource !== 'CLINICIAN_ENTERED') return notEligible('CLINICAL_HISTORY_INSUFFICIENT', 'ANCHOR_CLINICAL_TIME_NOT_MEASURED')
  // E5 — minimum measured history
  const { visits, evidence } = buildMeasuredVisits(ordered, status)
  counts.measuredVisitCount = evidence.visitDays.length
  counts.positiveGapCount = evidence.gaps.length
  if (counts.measuredVisitCount < CAD_MIN_VISITS) {
    return notEligible('CLINICAL_HISTORY_INSUFFICIENT', 'MEASURED_VISITS_BELOW_MINIMUM', { cadenceEvidence: evidence })
  }
  // E6 — cadence (NEW S4: S-CAD-3)
  const cadence = sCad3(evidence.gaps)
  if (cadence.status === 'ABSTAIN') {
    return notEligible('FREQUENCY_UNRELIABLE', cadence.reason, { cadenceEvidence: evidence, cadence })
  }
  // E7 — eligible: anchor = latest REAL record (usable, clinician-timed)
  const anchorInstant = effectiveClinicalInstant(latest)
  const cutoffLocalDay = localClinicalDay(anchorInstant)
  // NEW S4 — feature history = EVERY usable REAL record (clinical order;
  // legacy rows at their recordedAt fallback). Never: forecasts of any set,
  // Predictions, risk scores, R evidence. The anchor is the latest REAL record.
  void visits
  const usable = ordered.filter(r => status.get(r.id) === 'USABLE')
  const horizons = planSequentialHorizons(input.patient, latest, cutoffLocalDay, cadence.intervalsDays, usable, model)
  const featureTrends = horizons.f1Trends
  return {
    ...base,
    eligibility: { status: 'FORECAST_ELIGIBLE', reason: cadence.method },
    anchor: {
      healthRecordId: latest.id, clinicalTimeSource: latest.clinicalTimeSource,
      knowledgeCutoff: anchorInstant.toISOString(), cutoffLocalDay,
    },
    cadenceEvidence: evidence,
    cadence,
    featureTrends,
    generation: { status: horizons.status, reason: horizons.reason },
    targets: horizons.targets,
  }
}
