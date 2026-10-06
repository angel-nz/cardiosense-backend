// NEW S2D — forecast orchestration: REAL data → S2B plan → canonical bridge →
// S2C compatibility → /forecast/score → locked, revalidated, atomic swap →
// fresh commit verification → neutral refresh socket.
//
// No new forecasting mathematics: the plan is S2B's, the bridge rules and the
// scoring client are S2C's. This module only sequences them and persists.
//
// Compute-then-swap: the candidate (incl. the AI call) is computed OUTSIDE any
// transaction; the swap transaction takes a per-patient advisory lock,
// re-reads every fingerprinted input, recomputes S-FP-1 (pure, no AI) and
// writes only if the candidate is still current. Bounded retries.
import { createHash, randomUUID } from 'crypto'
import type { Server as IOServer } from 'socket.io'
import { Prisma } from '@prisma/client'
import type { ForecastSupersedeReason, ForecastTrigger, RiskForecastSet } from '@prisma/client'
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'
import { isoDateToUTCDate, utcDateToISODate } from '@/lib/timezone'
import { PERSONALIZATION_VERSION } from '@/modules/predictions/personalization/personalization.constants'
import { planForecast, lifecycleOf, canonicalFingerprintPayload } from './domain'
import type { SBridgeIdentity, SEvaluatedPlan, SModelContractInput, SPatientInput, SRealRecordInput } from './domain/types'
import { toSRealRecordInput } from './domain/adapters'
import { findCanonicalBridgeForAnchor, type CanonicalBridgeCandidate } from './bridge/bridge.repository'
import { evaluateBridgeCompatibility, type BridgeCompatibility } from './bridge/bridge.compatibility'
import { scoreForecastTargets, type ForecastScore } from './scoring/forecastScore.client'
import { getCurrentModelContract } from './forecast.modelContract'
import * as repo from './forecast.repository'
import { ForecastCommitVerificationError, ForecastOrchestrationUnstableError, ForecastPlanInvariantError } from './forecast.errors'

export const MAX_SWAP_ATTEMPTS = 3
export const FORECAST_SOCKET_EVENT = 'risk_forecasts_changed'
type Client = typeof prisma | repo.Tx

// ─── inputs ─────────────────────────────────────────────────────────────
const RECORD_SELECT = {
  id: true, recordedAt: true, measuredAt: true, clinicalTimeSource: true, age: true, currentSmoker: true,
  cigsPerDay: true, bpMeds: true, diabetes: true, totChol: true, sysBP: true, diaBP: true, bmi: true,
  glucose: true,
} as const

interface Inputs { patient: SPatientInput; records: SRealRecordInput[] }

async function loadInputs(patientId: string, client: Client): Promise<Inputs | null> {
  const c = client as repo.Tx
  const p = await c.patient.findUnique({ where: { id: patientId }, select: { id: true, birthDate: true, sex: true, isActive: true, isHidden: true } })
  if (!p) return null
  const recs = await c.healthRecord.findMany({ where: { patientId }, select: RECORD_SELECT })
  return {
    patient: { patientId: p.id, birthDate: utcDateToISODate(p.birthDate), sex: p.sex, isActive: p.isActive, isHidden: p.isHidden },
    records: recs.map(toSRealRecordInput),
  }
}

// ─── plan + canonical bridge identity (two-pass fingerprint) ──────────────
interface PlannedWithBridge { plan: SEvaluatedPlan; bridge: CanonicalBridgeCandidate | null; identity: SBridgeIdentity | null }

const clinicalView = (p: SEvaluatedPlan) => JSON.stringify({ ...p, inputFingerprint: null })

async function planWithBridge(inp: Inputs, model: SModelContractInput, client: Client): Promise<PlannedWithBridge> {
  const plan0 = planForecast({ patient: inp.patient, records: inp.records, model, bridgeIdentity: null })
  if (plan0.kind !== 'EVALUATED') throw new ForecastPlanInvariantError('lifecycle-gated plan in ACTIVE path')
  let bridge: CanonicalBridgeCandidate | null = null
  let identity: SBridgeIdentity | null = null
  if (plan0.eligibility.status === 'FORECAST_ELIGIBLE' && plan0.anchor) {
    // S2C canonical selection: the bridge of the CANONICAL NEW-R Prediction of
    // the S anchor only (an older bridge never overrides a newer GLOBAL one).
    bridge = await findCanonicalBridgeForAnchor(inp.patient.patientId, plan0.anchor.healthRecordId, client as any)
    if (bridge.bridge) {
      const b = bridge.bridge
      identity = { bridgeStateId: b.id, bridgeVersion: b.bridgeVersion, personalizationVersion: b.personalizationVersion, modelVersion: b.modelVersion }
    }
  }
  const plan1 = identity ? planForecast({ patient: inp.patient, records: inp.records, model, bridgeIdentity: identity }) : plan0
  if (plan1.kind !== 'EVALUATED' || clinicalView(plan1) !== clinicalView(plan0)) {
    throw new ForecastPlanInvariantError('bridge identity changed the clinical plan')
  }
  return { plan: plan1, bridge, identity }
}

// Component digests of the S-FP-1 payload (stored with the set) — used only
// to select an ACCURATE supersede reason, never as an input.
export interface InputComponents { records: string; demographics: string; bridge: string; contract: string }
function inputComponents(inp: Inputs, model: SModelContractInput, identity: SBridgeIdentity | null): InputComponents {
  const el = JSON.parse(canonicalFingerprintPayload({ patient: inp.patient, records: inp.records, model, bridgeIdentity: identity })) as unknown[]
  const d = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
  const patient = el[1] as unknown[]
  return { records: d(el[5]), demographics: d([patient[2], patient[3]]), bridge: d(el[4]), contract: d([el[2], el[3]]) }
}

// ─── candidate ──────────────────────────────────────────────────────────
export interface Candidate {
  patientId:   string
  fingerprint: string
  components:  InputComponents
  model:       SModelContractInput
  setData:     Omit<Prisma.RiskForecastSetUncheckedCreateInput, 'id' | 'patientId' | 'currentForPatientId' | 'trigger'>
  forecasts:   Omit<Prisma.RiskForecastCreateManyInput, 'setId' | 'patientId'>[]
  plan:        SEvaluatedPlan
  compat:      BridgeCompatibility | null
  scored:      boolean
}

async function computeCandidate(inp: Inputs, model: SModelContractInput): Promise<Candidate> {
  const { plan, bridge, identity } = await planWithBridge(inp, model, prisma)
  let generationStatus: Candidate['setData']['generationStatus'] = plan.generation.status
  let generationReason: string | null = plan.generation.reason
  let compat: BridgeCompatibility | null = null
  let scores: ForecastScore[] | null = null
  let riskInterpretation: 'GLOBAL' | 'INDIVIDUALIZED_BRIDGE' | null = null

  if (plan.eligibility.status === 'FORECAST_ELIGIBLE' && plan.anchor) {
    const anchor = inp.records.find(r => r.id === plan.anchor!.healthRecordId)!
    compat = evaluateBridgeCompatibility({
      patient: { patientId: inp.patient.patientId, birthDate: inp.patient.birthDate, sex: inp.patient.sex },
      anchor, records: inp.records, currentModelVersion: model.modelVersion,
      expectedPersonalizationVersion: PERSONALIZATION_VERSION, candidate: bridge,
    })
    if (plan.targets.length > 0) {
      try {
        scores = await scoreForecastTargets({
          expectedModelVersion: model.modelVersion,
          targets: plan.targets.map(t => t.simulatedState),
          appliedLogit: compat.compatible ? compat.appliedLogit : null,
        })
        riskInterpretation = compat.interpretation
      } catch (err: any) {
        // Technical AI failure: persisted as FAILED, never fabricated / reused.
        generationStatus = 'FAILED'
        generationReason = `FORECAST_SCORING_FAILED:${err?.code ?? err?.name ?? 'UNKNOWN'}`
        scores = null
      }
    }
  }
  const scored = scores !== null
  const cad = plan.cadence
  const components = inputComponents(inp, model, identity)
  const setData: Candidate['setData'] = {
    eligibilityStatus: plan.eligibility.status,
    eligibilityReason: plan.eligibility.reason,
    // NEW S3 — + S-CAD-2 diagnostics and the per-feature robust trend summary
    // (set-level audit JSON; never part of the public projection payload).
    eligibilityCounts: {
      counts: plan.counts, cadenceEvidence: plan.cadenceEvidence,
      cadenceDiagnostics: cad?.diagnostics ?? null, featureTrends: plan.featureTrends ?? null,
      // NEW S4 — S-CAD-3 two-mode trace (labels, transition counts, sequence).
      cadenceModes: cad?.status === 'OK' ? cad.multimodal : null,
      inputComponents: components,
    } as unknown as Prisma.InputJsonValue,
    generationStatus, generationReason,
    anchorHealthRecordId:     plan.anchor?.healthRecordId ?? null,
    knowledgeCutoff:          plan.anchor ? new Date(plan.anchor.knowledgeCutoff) : null,
    cutoffLocalDay:           plan.anchor ? isoDateToUTCDate(plan.anchor.cutoffLocalDay) : null,
    anchorClinicalTimeSource: plan.anchor?.clinicalTimeSource ?? null,
    // NEW S4 — a multimodal cadence has NO single delta (null); its exact
    // 3-interval sequence is cadenceIntervalsDays (unimodal: [d,d,d]).
    cadenceDaysRaw: cad?.status === 'OK' && cad.deltaRaw !== null ? String(cad.deltaRaw) : null,
    cadenceDays:    cad?.status === 'OK' ? cad.deltaDays : null,
    cadenceIntervalsDays: cad?.status === 'OK' ? [...cad.intervalsDays] : [],
    cadenceMethod:  cad?.status === 'OK' ? cad.method : null,
    cadenceReason:  cad?.status === 'ABSTAIN' ? cad.reason : null,
    // Bridge fields are recorded whenever scoring was ATTEMPTED (scored or FAILED).
    riskInterpretation,
    rBridgeStateId: compat && plan.targets.length > 0 && compat.compatible ? compat.bridgeStateId : null,
    rBridgeReason:  compat && plan.targets.length > 0 && !compat.compatible ? compat.reason : null,
    sVersion:                  plan.policies.sVersion,
    featurePolicyVersion:      plan.policies.featurePolicyVersion,
    clinicalTimePolicyVersion: plan.policies.clinicalTimePolicyVersion,
    cadencePolicyVersion:      plan.policies.cadencePolicyVersion,
    modelVersion:              model.modelVersion,
    inputFingerprint:          plan.inputFingerprint,
  }
  const forecasts = scored ? plan.targets.map((t, i) => {
    const s = scores![i]
    if (s.targetIndex !== i) throw new ForecastPlanInvariantError('score/target pairing')
    return {
      horizonIndex: t.horizonIndex, targetDate: isoDateToUTCDate(t.targetDate), targetAge: t.targetAge,
      simulatedState: t.simulatedState as unknown as Prisma.InputJsonValue,
      featureProvenance: t.featureProvenance as unknown as Prisma.InputJsonValue,
      assumptionFlags: t.assumptionFlags as unknown as Prisma.InputJsonValue,
      // NEW S4 — per-horizon sequential context provenance (internal audit JSON).
      sequentialContext: t.sequentialContext ? (t.sequentialContext as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      globalRiskScore: s.globalRiskScore, finalRiskScore: s.finalRiskScore, riskLevel: s.riskLevel,
    }
  }) : []
  return { patientId: inp.patient.patientId, fingerprint: plan.inputFingerprint, components, model, setData, forecasts, plan, compat, scored }
}

// ─── supersede-reason selection (documented algorithm) ───────────────────
// 1. same fingerprint & CURRENT FAILED            → RETRY_AFTER_FAILURE
// 2. any version / model-contract difference       → MODEL_OR_POLICY_VERSION_CHANGED
// 3. REAL record set/values differ                 → NEW_REAL_RECORD
// 4. patient sex / birthDate differ                → DEMOGRAPHICS_CHANGED
// 5. canonical bridge identity differs             → ANCHOR_R_STATE_CHANGED
// 6. (no stored components) fall back to the trigger's cause
const VERSION_FIELDS = ['sVersion', 'featurePolicyVersion', 'clinicalTimePolicyVersion', 'cadencePolicyVersion', 'modelVersion'] as const
const TRIGGER_FALLBACK: Record<ForecastTrigger, ForecastSupersedeReason> = {
  HEALTH_RECORD_CREATED: 'NEW_REAL_RECORD', ANCHOR_PREDICTION_PERSISTED: 'ANCHOR_R_STATE_CHANGED',
  DEMOGRAPHICS_CHANGED: 'DEMOGRAPHICS_CHANGED', PATIENT_REACTIVATED: 'NEW_REAL_RECORD', BOOTSTRAP: 'MODEL_OR_POLICY_VERSION_CHANGED',
}
export function selectSupersedeReason(current: RiskForecastSet, cand: Candidate, trigger: ForecastTrigger): ForecastSupersedeReason {
  if (current.generationStatus === 'FAILED' && current.inputFingerprint === cand.fingerprint) return 'RETRY_AFTER_FAILURE'
  if (VERSION_FIELDS.some(f => current[f] !== (cand.setData as any)[f])) return 'MODEL_OR_POLICY_VERSION_CHANGED'
  const prev = (current.eligibilityCounts as any)?.inputComponents as InputComponents | undefined
  if (prev) {
    if (prev.contract !== cand.components.contract) return 'MODEL_OR_POLICY_VERSION_CHANGED'
    if (prev.records !== cand.components.records) return 'NEW_REAL_RECORD'
    if (prev.demographics !== cand.components.demographics) return 'DEMOGRAPHICS_CHANGED'
    if (prev.bridge !== cand.components.bridge) return 'ANCHOR_R_STATE_CHANGED'
  }
  return TRIGGER_FALLBACK[trigger]
}

// ─── swap (locked, revalidated, atomic) ──────────────────────────────────
type SwapResult =
  | { kind: 'STALE' }
  | { kind: 'NOOP'; setId: string }
  | { kind: 'WRITTEN'; newSetId: string; oldSetId: string | null; reason: ForecastSupersedeReason | null; horizons: number[] }

async function trySwap(cand: Candidate, trigger: ForecastTrigger): Promise<SwapResult> {
  return prisma.$transaction(async tx => {
    await repo.lockPatientForecasts(tx, cand.patientId)
    const inp = await loadInputs(cand.patientId, tx)
    if (!inp || lifecycleOf(inp.patient) !== 'ACTIVE') return { kind: 'STALE' } as const
    const { plan } = await planWithBridge(inp, cand.model, tx)          // pure re-plan, NO AI call
    if (plan.inputFingerprint !== cand.fingerprint) return { kind: 'STALE' } as const
    const current = await repo.findCurrentSet(cand.patientId, tx)
    if (current && current.inputFingerprint === cand.fingerprint && current.generationStatus !== 'FAILED' &&
        VERSION_FIELDS.every(f => current[f] === (cand.setData as any)[f])) {
      return { kind: 'NOOP', setId: current.id } as const
    }
    const reason = current ? selectSupersedeReason(current, cand, trigger) : null
    const newSetId = randomUUID()
    if (current) await repo.supersedeCurrent(tx, current.id, reason!, new Date())
    await repo.insertCurrentSet(tx, { ...cand.setData, id: newSetId, patientId: cand.patientId, currentForPatientId: cand.patientId, trigger })
    if (current) await repo.linkSupersededBy(tx, current.id, newSetId)
    await repo.insertForecasts(tx, cand.forecasts.map(f => ({ ...f, setId: newSetId, patientId: cand.patientId })))
    return { kind: 'WRITTEN', newSetId, oldSetId: current?.id ?? null, reason, horizons: cand.forecasts.map(f => f.horizonIndex as number) } as const
  }, { timeout: 30_000 })
}

// Fresh, outside-transaction verification (Prisma may resolve a transaction
// whose COMMIT PostgreSQL rolled back — proven natively in S2C-FIX1).
export async function verifyForecastSwapCommitted(e: { patientId: string; newSetId: string | null; oldSetId: string | null; horizons: number[] }): Promise<void> {
  const fail = (inv: string): never => {
    logger.error('Forecast swap resolved but committed state is not visible', { code: 'FORECAST_COMMIT_NOT_VISIBLE', invariant: inv, setId: e.newSetId })
    throw new ForecastCommitVerificationError(inv)
  }
  if (e.newSetId) {
    const s = await prisma.riskForecastSet.findUnique({ where: { id: e.newSetId }, select: { currentForPatientId: true, patientId: true } })
    if (!s) fail('F1_NEW_SET_MISSING')
    if (s!.patientId !== e.patientId || s!.currentForPatientId !== e.patientId) fail('F1_NEW_SET_NOT_CURRENT')
    const rows = await prisma.riskForecast.findMany({ where: { setId: e.newSetId }, select: { horizonIndex: true }, orderBy: { horizonIndex: 'asc' } })
    if (rows.map(r => r.horizonIndex).join() !== e.horizons.join()) fail('F3_FORECAST_ROWS')
  }
  if (e.oldSetId) {
    const o = await prisma.riskForecastSet.findUnique({ where: { id: e.oldSetId }, select: { currentForPatientId: true, supersededBySetId: true, supersededAt: true } })
    if (!o || o.currentForPatientId !== null || o.supersededAt === null || o.supersededBySetId !== e.newSetId) fail('F2_OLD_SET_STILL_CURRENT')
  }
}

function emitChanged(io: IOServer | undefined, patientId: string, currentSetId: string | null, cause: string) {
  try { io?.to(`patient:${patientId}`).emit(FORECAST_SOCKET_EVENT, { patientId, currentSetId, cause }) }
  catch (err) { logger.warn('risk_forecasts_changed emit failed — state already committed', { patientId, err: err instanceof Error ? err.message : String(err) }) }
}

// ─── lifecycle supersession (no replacement) ─────────────────────────────
export function lifecycleSupersedeReason(p: { isActive: boolean; isHidden: boolean }): ForecastSupersedeReason {
  return p.isActive && p.isHidden ? 'PATIENT_LIFECYCLE_INVALID' : 'PATIENT_LEFT_ACTIVE'
}

// For use INSIDE a caller's transaction (e.g. the lifecycle mutation itself).
export async function supersedeCurrentForLifecycleInTx(tx: repo.Tx, patientId: string, reason: ForecastSupersedeReason): Promise<string | null> {
  await repo.lockPatientForecasts(tx, patientId)
  const current = await repo.findCurrentSet(patientId, tx)
  if (!current) return null
  await repo.supersedeCurrent(tx, current.id, reason, new Date())
  return current.id
}

async function runLifecycleSupersession(patientId: string, io?: IOServer): Promise<{ supersededSetId: string | null; reason: ForecastSupersedeReason | null }> {
  const res = await prisma.$transaction(async tx => {
    await repo.lockPatientForecasts(tx, patientId)
    const p = await tx.patient.findUnique({ where: { id: patientId }, select: { isActive: true, isHidden: true } })
    if (!p || (p.isActive && !p.isHidden)) return { supersededSetId: null, reason: null }
    const reason = lifecycleSupersedeReason(p)
    const current = await repo.findCurrentSet(patientId, tx)
    if (!current) return { supersededSetId: null, reason }
    await repo.supersedeCurrent(tx, current.id, reason, new Date())
    return { supersededSetId: current.id, reason }
  })
  if (res.supersededSetId) {
    await verifyLifecycleSupersessionCommitted(res.supersededSetId)
    emitChanged(io, patientId, null, res.reason!)
  }
  return res
}

// Fresh check for a supersession WITHOUT replacement (no successor link).
export async function verifyLifecycleSupersessionCommitted(supersededSetId: string): Promise<void> {
  const o = await prisma.riskForecastSet.findUnique({ where: { id: supersededSetId }, select: { currentForPatientId: true, supersededAt: true } })
  if (!o || o.currentForPatientId !== null || o.supersededAt === null) {
    logger.error('Lifecycle forecast supersession resolved but is not visible', { code: 'FORECAST_COMMIT_NOT_VISIBLE', invariant: 'F2_LIFECYCLE_SET_STILL_CURRENT', setId: supersededSetId })
    throw new ForecastCommitVerificationError('F2_LIFECYCLE_SET_STILL_CURRENT')
  }
}

// Defensive cleanup: a CURRENT set must not exist for a patient that is not
// ACTIVE + visible (hide/show/bulk visibility, or anything unexpected).
export async function reconcileLifecycleForPatients(patientIds: string[], io?: IOServer): Promise<number> {
  let n = 0
  for (const id of patientIds) if ((await runLifecycleSupersession(id, io)).supersededSetId) n++
  return n
}

export async function reconcileLifecycleForDoctor(doctorId: string, io?: IOServer): Promise<number> {
  const rows = await prisma.riskForecastSet.findMany({
    where: { currentForPatientId: { not: null }, patient: { doctorId, OR: [{ isActive: false }, { isHidden: true }] } },
    select: { patientId: true },
  })
  return reconcileLifecycleForPatients(rows.map(r => r.patientId), io)
}

// ─── public entry point ──────────────────────────────────────────────────
export type OrchestrationOutcome =
  | 'CREATED' | 'REPLACED' | 'IDEMPOTENT_NOOP'
  | 'LIFECYCLE_SUPERSEDED' | 'LIFECYCLE_NOOP' | 'PATIENT_NOT_FOUND'
  | 'DRY_RUN_CREATE' | 'DRY_RUN_REPLACE' | 'DRY_RUN_NOOP' | 'DRY_RUN_LIFECYCLE_SUPERSEDE' | 'DRY_RUN_LIFECYCLE_NOOP'

export interface OrchestrationResult {
  patientId:          string
  lifecycle:          string
  outcome:            OrchestrationOutcome
  setId:              string | null
  previousSetId:      string | null
  supersedeReason:    ForecastSupersedeReason | null
  eligibilityStatus:  string | null
  eligibilityReason:  string | null
  generationStatus:   string | null
  riskInterpretation: string | null
  rBridgeReason:      string | null
  attempts:           number
}

export interface OrchestrateOptions {
  patientId: string
  trigger:   ForecastTrigger
  io?:       IOServer
  dryRun?:   boolean
  // test seam: invoked after a candidate is computed and before the swap
  _afterCandidate?: (attempt: number) => Promise<void>
}

export async function orchestrateForecast(o: OrchestrateOptions): Promise<OrchestrationResult> {
  const base = (lifecycle: string, outcome: OrchestrationOutcome, attempts: number, extra: Partial<OrchestrationResult> = {}): OrchestrationResult => ({
    patientId: o.patientId, lifecycle, outcome, setId: null, previousSetId: null, supersedeReason: null,
    eligibilityStatus: null, eligibilityReason: null, generationStatus: null, riskInterpretation: null, rBridgeReason: null, attempts, ...extra,
  })
  for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
    const inp = await loadInputs(o.patientId, prisma)
    if (!inp) return base('UNKNOWN', 'PATIENT_NOT_FOUND', attempt)
    const lifecycle = lifecycleOf(inp.patient)
    if (lifecycle !== 'ACTIVE') {
      if (o.dryRun) {
        const cur = await repo.findCurrentSet(o.patientId)
        return base(lifecycle, cur ? 'DRY_RUN_LIFECYCLE_SUPERSEDE' : 'DRY_RUN_LIFECYCLE_NOOP', attempt, { previousSetId: cur?.id ?? null, supersedeReason: cur ? lifecycleSupersedeReason(inp.patient) : null })
      }
      const r = await runLifecycleSupersession(o.patientId, o.io)
      return base(lifecycle, r.supersededSetId ? 'LIFECYCLE_SUPERSEDED' : 'LIFECYCLE_NOOP', attempt, { previousSetId: r.supersededSetId, supersedeReason: r.supersededSetId ? r.reason : null })
    }
    const model = await getCurrentModelContract()
    const cand = await computeCandidate(inp, model)
    const summary = {
      eligibilityStatus: cand.setData.eligibilityStatus as string, eligibilityReason: cand.setData.eligibilityReason as string,
      generationStatus: cand.setData.generationStatus as string, riskInterpretation: (cand.setData.riskInterpretation ?? null) as string | null,
      rBridgeReason: (cand.setData.rBridgeReason ?? null) as string | null,
    }
    if (o.dryRun) {
      const cur = await repo.findCurrentSet(o.patientId)
      if (cur && cur.inputFingerprint === cand.fingerprint && cur.generationStatus !== 'FAILED' && VERSION_FIELDS.every(f => cur[f] === (cand.setData as any)[f])) {
        return base('ACTIVE', 'DRY_RUN_NOOP', attempt, { setId: cur.id, ...summary })
      }
      return base('ACTIVE', cur ? 'DRY_RUN_REPLACE' : 'DRY_RUN_CREATE', attempt, { previousSetId: cur?.id ?? null, supersedeReason: cur ? selectSupersedeReason(cur, cand, o.trigger) : null, ...summary })
    }
    if (o._afterCandidate) await o._afterCandidate(attempt)
    const sw = await trySwap(cand, o.trigger)
    if (sw.kind === 'STALE') continue
    if (sw.kind === 'NOOP') return base('ACTIVE', 'IDEMPOTENT_NOOP', attempt, { setId: sw.setId, ...summary })
    await verifyForecastSwapCommitted({ patientId: o.patientId, newSetId: sw.newSetId, oldSetId: sw.oldSetId, horizons: sw.horizons })
    emitChanged(o.io, o.patientId, sw.newSetId, o.trigger)
    return base('ACTIVE', sw.oldSetId ? 'REPLACED' : 'CREATED', attempt, { setId: sw.newSetId, previousSetId: sw.oldSetId, supersedeReason: sw.reason, ...summary })
  }
  logger.error('Forecast orchestration unstable — inputs kept changing', { code: 'FORECAST_ORCHESTRATION_UNSTABLE', attempts: MAX_SWAP_ATTEMPTS })
  throw new ForecastOrchestrationUnstableError(MAX_SWAP_ATTEMPTS)
}
