// NEW S2D — explicit allowlist serializer for forecast PROJECTIONS.
// Never returns raw Prisma rows. Excluded on purpose: inputFingerprint and its
// stored input components, rBridgeStateId and every bridge internal
// (appliedLogit, sexUsed, raw bridge state), R provenance JSON.
import type { RiskForecast } from '@prisma/client'
import { utcDateToISODate } from '@/lib/timezone'
import { S_POLICY_VERSIONS } from './domain/constants'
import type { SModelContractInput } from './domain/types'
import type { ForecastSetWithForecasts } from './forecast.repository'

export function isVersionStale(set: Pick<ForecastSetWithForecasts, 'sVersion' | 'featurePolicyVersion' | 'clinicalTimePolicyVersion' | 'cadencePolicyVersion' | 'modelVersion'>,
  model: SModelContractInput | null): boolean {
  const policyStale = set.sVersion !== S_POLICY_VERSIONS.sVersion ||
    set.featurePolicyVersion !== S_POLICY_VERSIONS.featurePolicyVersion ||
    set.clinicalTimePolicyVersion !== S_POLICY_VERSIONS.clinicalTimePolicyVersion ||
    set.cadencePolicyVersion !== S_POLICY_VERSIONS.cadencePolicyVersion
  return policyStale || (model !== null && set.modelVersion !== model.modelVersion)
}

// NEW S4 — public summary of the per-horizon sequential context: which
// in-run simulated horizons fed this horizon's trend, how many REAL records,
// the policy weights and the per-feature trend summary. Record ids and pair
// arrays stay internal.
function publicSequentialContext(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as { realRecordCount?: number; simulatedContext?: string[]; weights?: unknown; features?: Record<string, { rawSlope: number; trendConsistency: number; effectiveSlope: number }> }
  return {
    realRecordCount:  c.realRecordCount ?? null,
    simulatedContext: Array.isArray(c.simulatedContext) ? c.simulatedContext : [],
    weights:          c.weights ?? null,
    features: c.features ? Object.fromEntries(Object.entries(c.features).map(([k, v]) => [k, { rawSlope: v.rawSlope, trendConsistency: v.trendConsistency, effectiveSlope: v.effectiveSlope }])) : null,
  }
}

function toProjection(f: RiskForecast) {
  return {
    horizonIndex:      f.horizonIndex,
    targetDate:        utcDateToISODate(f.targetDate),
    targetAge:         f.targetAge,
    simulatedState:    f.simulatedState,
    featureProvenance: f.featureProvenance,
    assumptionFlags:   f.assumptionFlags,
    sequentialContext: publicSequentialContext(f.sequentialContext),   // NEW S4 (null on pre-S4 rows)
    globalRiskScore:   Number(f.globalRiskScore),
    finalRiskScore:    Number(f.finalRiskScore),
    riskLevel:         f.riskLevel,
  }
}

export function toForecastSetView(set: ForecastSetWithForecasts, model: SModelContractInput | null) {
  const stored = (set.eligibilityCounts ?? {}) as { counts?: unknown; cadenceEvidence?: unknown; cadenceModes?: { modes?: Array<{ label: string; valueDays: number }>; sequence?: string[]; latestMode?: string } | null }
  return {
    kind: 'RISK_PROJECTION_SET' as const,
    id:   set.id,
    isCurrent: set.currentForPatientId !== null,
    trigger:   set.trigger,
    createdAt: set.createdAt.toISOString(),
    eligibility: { status: set.eligibilityStatus, reason: set.eligibilityReason, counts: stored.counts ?? null },
    generation:  { status: set.generationStatus, reason: set.generationReason },
    anchor: set.anchorHealthRecordId ? {
      healthRecordId:     set.anchorHealthRecordId,
      knowledgeCutoff:    set.knowledgeCutoff ? set.knowledgeCutoff.toISOString() : null,
      cutoffLocalDay:     set.cutoffLocalDay ? utcDateToISODate(set.cutoffLocalDay) : null,
      clinicalTimeSource: set.anchorClinicalTimeSource,
    } : null,
    cadence: {
      deltaDaysRaw: set.cadenceDaysRaw === null ? null : Number(set.cadenceDaysRaw),
      deltaDays:    set.cadenceDays,
      method:       set.cadenceMethod,
      reason:       set.cadenceReason,
      evidence:     stored.cadenceEvidence ?? null,
      // NEW S4 — S-CAD-3: exact horizon intervals (cumulative target dates)
      // and, for a two-mode cadence, the modes (no single cadence value).
      intervalsDays: set.cadenceIntervalsDays ?? [],
      multimodal: stored.cadenceModes ? {
        modes:      (stored.cadenceModes.modes ?? []).map(m => ({ label: m.label, valueDays: m.valueDays })),
        latestMode: stored.cadenceModes.latestMode ?? null,
        sequence:   stored.cadenceModes.sequence ?? [],
      } : null,
    },
    riskInterpretation: set.riskInterpretation,
    rBridgeReason:      set.rBridgeReason,
    versions: {
      sVersion: set.sVersion, featurePolicyVersion: set.featurePolicyVersion,
      clinicalTimePolicyVersion: set.clinicalTimePolicyVersion, cadencePolicyVersion: set.cadencePolicyVersion,
      modelVersion: set.modelVersion,
    },
    versionStale:          isVersionStale(set, model),
    modelContractVerified: model !== null,
    uncertainty:           'NOT_QUANTIFIED' as const,
    supersession: set.currentForPatientId !== null ? null : {
      supersededAt: set.supersededAt ? set.supersededAt.toISOString() : null,
      reason:       set.supersedeReason,
      supersededBySetId: set.supersededBySetId,
    },
    projections: set.forecasts.map(toProjection),
  }
}
