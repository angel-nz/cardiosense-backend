// NEW S2D — explicit forecast bootstrap over the FULL patient universe.
//
// Uses the SAME orchestrator / idempotency / lifecycle logic as live triggers
// (trigger BOOTSTRAP); there is no separate simplified algorithm.
//   dry-run (default): computes every candidate — INCLUDING the AI
//     /forecast/score call for eligible plans, for accurate reporting — and
//     reports what WOULD happen; performs no RiskForecast write or supersession.
//   --apply: runs the orchestrator for real.
// No scheduler: this runs only when invoked (deployment, model/policy change,
// retry of FAILED sets).
import { prisma } from '@/config/prisma'
import { orchestrateForecast, type OrchestrationResult } from './forecast.orchestrator'

export interface BootstrapReport {
  mode: 'DRY_RUN' | 'APPLY'
  counts: Record<string, number>
  patients: { patient: string; lifecycle: string; outcome: string; eligibility: string | null; generation: string | null; interpretation: string | null; reason: string | null; error?: string }[]
}

const KEYS = ['patientsScanned', 'activeVisible', 'inactive', 'hidden', 'invalidLifecycle',
  'historyAbsent', 'historyInvalid', 'clinicalHistoryInsufficient', 'frequencyUnreliable', 'forecastEligible',
  'generatedFull', 'generatedPartial', 'noneAdmissible', 'failed', 'global', 'individualizedBridge',
  'created', 'unchangedIdempotent', 'replaced', 'lifecycleSuperseded', 'skipped', 'errors'] as const

export async function runForecastBootstrap(opts: { apply: boolean; patientIds?: string[] }): Promise<BootstrapReport> {
  const counts: Record<string, number> = Object.fromEntries(KEYS.map(k => [k, 0]))
  const patients: BootstrapReport['patients'] = []
  const universe = await prisma.patient.findMany({
    where: opts.patientIds ? { id: { in: opts.patientIds } } : {},
    select: { id: true, isActive: true, isHidden: true }, orderBy: { id: 'asc' },
  })
  for (const p of universe) {
    counts.patientsScanned++
    if (p.isActive && p.isHidden) counts.invalidLifecycle++
    else if (p.isHidden) counts.hidden++
    else if (!p.isActive) counts.inactive++
    else counts.activeVisible++
    let r: OrchestrationResult | null = null
    try {
      r = await orchestrateForecast({ patientId: p.id, trigger: 'BOOTSTRAP', dryRun: !opts.apply })
    } catch (err: any) {
      counts.errors++
      patients.push({ patient: p.id.slice(0, 8), lifecycle: '?', outcome: 'ERROR', eligibility: null, generation: null, interpretation: null, reason: null, error: err?.code ?? err?.name ?? 'Error' })
      continue
    }
    const inc = (k: string) => { counts[k]++ }
    switch (r.eligibilityStatus) {
      case 'HISTORY_ABSENT': inc('historyAbsent'); break
      case 'HISTORY_INVALID': inc('historyInvalid'); break
      case 'CLINICAL_HISTORY_INSUFFICIENT': inc('clinicalHistoryInsufficient'); break
      case 'FREQUENCY_UNRELIABLE': inc('frequencyUnreliable'); break
      case 'FORECAST_ELIGIBLE': inc('forecastEligible'); break
    }
    switch (r.generationStatus) {
      case 'GENERATED_FULL': inc('generatedFull'); break
      case 'GENERATED_PARTIAL': inc('generatedPartial'); break
      case 'NONE_ADMISSIBLE': inc('noneAdmissible'); break
      case 'FAILED': inc('failed'); break
    }
    if (r.riskInterpretation === 'GLOBAL') inc('global')
    if (r.riskInterpretation === 'INDIVIDUALIZED_BRIDGE') inc('individualizedBridge')
    switch (r.outcome) {
      case 'CREATED': case 'DRY_RUN_CREATE': inc('created'); break
      case 'REPLACED': case 'DRY_RUN_REPLACE': inc('replaced'); break
      case 'IDEMPOTENT_NOOP': case 'DRY_RUN_NOOP': inc('unchangedIdempotent'); break
      case 'LIFECYCLE_SUPERSEDED': case 'DRY_RUN_LIFECYCLE_SUPERSEDE': inc('lifecycleSuperseded'); break
      default: inc('skipped')
    }
    patients.push({ patient: p.id.slice(0, 8), lifecycle: r.lifecycle, outcome: r.outcome, eligibility: r.eligibilityStatus,
      generation: r.generationStatus, interpretation: r.riskInterpretation, reason: r.supersedeReason ?? r.eligibilityReason })
  }
  return { mode: opts.apply ? 'APPLY' : 'DRY_RUN', counts, patients }
}
