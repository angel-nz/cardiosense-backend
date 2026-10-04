// NEW R (R4B) — PURE causal-evidence builder (no I/O, no Prisma client, no
// clock). Implements the frozen R3 / R3-FIX1 / R3-FIX2 evidence policy for one
// authorized patient and one anchor HealthRecord:
//
//   prior HealthRecords (already patient-scoped + causally cut by the repo)
//   → validity / model-domain filter          (INVALID, OUT_OF_DOMAIN)
//   → same-timestamp policy                   (AMBIGUOUS_TIMESTAMP)
//   → anchor-duplicate rule                   (DUPLICATE_OF_ANCHOR)
//   → anchored 60-min bursts = effective clinical units
//   → within-burst identical-state collapse (information cap: distinct states
//     are KEPT as separate observations, never averaged)
//   → ≤ 1 canonical persisted GLOBAL prediction value (π) per unit
//   → counts + SHA-256 evidence fingerprint
//
// It computes NO latent state, γ, gradient, conditioned input or risk — those
// belong to the AI service (R4C). It never decides a personalization status.
//
// Determinism: the result depends only on recordedAt / predictedAt / clinical
// values / scores. UUIDs never drive ordering or selection; they appear only
// as provenance identifiers inside the fingerprint (sorted for serialization).
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { CreateRecordDto } from '@/modules/health-records/record.dto'
import {
  PERSONALIZATION_VERSION, EVIDENCE_BURST_WINDOW_MS, ANCHOR_DUPLICATE_WINDOW_MS, MS_PER_DAY,
} from './personalization.constants'

type DecimalLike = Prisma.Decimal | number | string

// ─── Input shapes (exactly what the scoped repositories select) ────────────
export interface EvidenceRecordRow {
  id:            string
  patientId:     string
  recordedAt:    Date
  age:           number
  currentSmoker: boolean
  cigsPerDay:    number
  bpMeds:        boolean
  diabetes:      boolean
  totChol:       DecimalLike
  sysBP:         DecimalLike
  diaBP:         DecimalLike
  bmi:           DecimalLike
  heartRate:     number
  glucose:       DecimalLike
}

export interface EvidencePredictionRow {
  id:                    string
  patientId:             string
  healthRecordId:        string | null
  riskScore:             DecimalLike
  globalRiskScore:       DecimalLike | null
  personalizationStatus: string | null   // NULL ⇒ legacy / pre-NEW-R row
  modelVersion:          string | null
  sexUsed:               number | null
  predictedAt:           Date
}

export interface BuildEvidenceInput {
  patientId:          string                 // already authorized by the caller
  anchor:             EvidenceRecordRow       // the HealthRecord being predicted
  priorRecords:       EvidenceRecordRow[]
  predictions:        EvidencePredictionRow[]
  globalModelVersion: string                  // current canonical global version (AI /health)
  eligibleAgeRange:   { min: number; max: number }
}

// ─── Output shapes ─────────────────────────────────────────────────────────
// Conditioned-feature observation (R3 item 7: sysBP, diaBP, totChol, glucose).
export interface EvidenceState {
  tDays:   number   // (recordedAt − anchor.recordedAt) / 1 day  → negative
  sysBP:   number
  diaBP:   number
  totChol: number
  glucose: number
}

// Comparability state attached to an accepted π (R3 item 22 / R3-FIX1 §6).
export interface EvidencePiState {
  age:           number
  currentSmoker: 0 | 1
  cigsPerDay:    number
  BPMeds:        0 | 1
  diabetes:      0 | 1
  BMI:           number
  heartRate:     number
  sexUsed:       0 | 1 | null   // NULL = legacy / unknown provenance; never substituted
}

export interface EvidenceUnit {
  tDays:   number                  // unit time = latest member recordedAt, relative to anchor
  states:  EvidenceState[]         // distinct states, real time order; m_b = states.length
  pi:      { score: number; scoreBp: number } | null   // canonical GLOBAL score (4-dp, basis points)
  piState: EvidencePiState | null
  // Backend-internal provenance only — NEVER sent to the AI.
  source: { recordIds: string[]; piPredictionIds: string[] }
}

export interface EvidenceCounts {
  clinical: {
    rawRecords:                 number
    droppedOutOfScope:          number   // defensive; repositories already scope (expected 0)
    excludedInvalid:            number
    excludedOutOfDomain:        number
    excludedAmbiguousTimestamp: number
    excludedDuplicateOfAnchor:  number
    sameTimestampCollapsed:     number
    burstCollapsedDuplicates:   number
    effectiveUnits:             number
  }
  prediction: {
    candidateRows:              number
    droppedOutOfScope:          number   // defensive; repositories already scope (expected 0)
    excludedRecordNotEffective: number   // prediction of a prior record that was itself excluded
    excludedVersion:            number
    excludedMissingGlobalScore: number
    ambiguousGroups:            number
    canonicalUnits:             number
  }
}

export interface PersonalizationEvidence {
  personalizationVersion: typeof PERSONALIZATION_VERSION
  globalModelVersion:     string
  anchor:                 { recordId: string; recordedAtMs: number }
  units:                  EvidenceUnit[]
  counts:                 EvidenceCounts
  evidenceFingerprint:    string
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const dec = (v: DecimalLike) => new Prisma.Decimal(v)
const fixed2 = (v: DecimalLike) => dec(v).toFixed(2)
const num2 = (v: DecimalLike) => Number(dec(v).toFixed(2))

// Exact Decimal(5,4) basis points (δ = 1e-4). Values are persisted with 4
// decimals, so equality is exact integer equality — no float epsilon.
// A value that is not representable at 4 decimals is rejected (null), never
// rounded into a different persisted score.
export function scoreToBasisPoints(v: DecimalLike): number | null {
  const d = dec(v)
  if (!d.isFinite() || d.decimalPlaces() > 4) return null
  const bp = d.times(10_000)
  return bp.isInteger() ? bp.toNumber() : null
}

// Model-relevant equality vector: the 11 clinical fields of a HealthRecord
// (the global input minus patient-level sex). Notes and ids never participate.
export function clinicalStateKey(r: EvidenceRecordRow): string {
  return [
    r.age, r.currentSmoker ? 1 : 0, r.cigsPerDay, r.bpMeds ? 1 : 0, r.diabetes ? 1 : 0,
    fixed2(r.totChol), fixed2(r.sysBP), fixed2(r.diaBP), fixed2(r.bmi), r.heartRate, fixed2(r.glucose),
  ].join('|')
}

// Validity = the CURRENT model-input contract: the real CreateRecordDto
// ranges (identical to the AI PredictRequest ranges) + diaBP < sysBP.
const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000'
function isValidModelInput(r: EvidenceRecordRow): boolean {
  if (!Number.isInteger(r.age)) return false
  const parsed = CreateRecordDto.safeParse({
    patientId: PLACEHOLDER_UUID,
    age: r.age, currentSmoker: r.currentSmoker, cigsPerDay: r.cigsPerDay,
    bpMeds: r.bpMeds, diabetes: r.diabetes,
    totChol: num2(r.totChol), sysBP: num2(r.sysBP), diaBP: num2(r.diaBP),
    bmi: num2(r.bmi), heartRate: r.heartRate, glucose: num2(r.glucose),
  })
  return parsed.success && dec(r.diaBP).lessThan(dec(r.sysBP))
}

// A same-timestamp group of identical-state records = one effective candidate.
interface Candidate {
  timeMs:   number
  stateKey: string
  records:  EvidenceRecordRow[]   // ≥ 1, all identical clinical state
}

// ─── Builder ───────────────────────────────────────────────────────────────
export function buildPersonalizationEvidence(input: BuildEvidenceInput): PersonalizationEvidence {
  const { patientId, anchor, globalModelVersion, eligibleAgeRange } = input
  const anchorMs = anchor.recordedAt.getTime()
  const anchorKey = clinicalStateKey(anchor)

  const counts: EvidenceCounts = {
    clinical: {
      rawRecords: 0, droppedOutOfScope: 0, excludedInvalid: 0, excludedOutOfDomain: 0,
      excludedAmbiguousTimestamp: 0, excludedDuplicateOfAnchor: 0, sameTimestampCollapsed: 0,
      burstCollapsedDuplicates: 0, effectiveUnits: 0,
    },
    prediction: {
      candidateRows: 0, droppedOutOfScope: 0, excludedRecordNotEffective: 0, excludedVersion: 0, excludedMissingGlobalScore: 0,
      ambiguousGroups: 0, canonicalUnits: 0,
    },
  }

  // 1. Causal scope (defense in depth; the repository already applies it).
  const scoped: EvidenceRecordRow[] = []
  for (const r of input.priorRecords) {
    if (r.patientId !== patientId || r.id === anchor.id || !(r.recordedAt.getTime() < anchorMs)) {
      counts.clinical.droppedOutOfScope++
      continue
    }
    scoped.push(r)
  }
  counts.clinical.rawRecords = scoped.length

  // 2. Validity, then model domain.
  const valid: EvidenceRecordRow[] = []
  for (const r of scoped) {
    if (!isValidModelInput(r)) { counts.clinical.excludedInvalid++; continue }
    if (r.age < eligibleAgeRange.min || r.age > eligibleAgeRange.max) { counts.clinical.excludedOutOfDomain++; continue }
    valid.push(r)
  }

  // 3. Same-timestamp policy: identical ⇒ one candidate; conflicting ⇒ the
  //    whole timestamp group is AMBIGUOUS_TIMESTAMP (never pick or average).
  const byTime = new Map<number, EvidenceRecordRow[]>()
  for (const r of valid) {
    const t = r.recordedAt.getTime()
    const g = byTime.get(t)
    if (g) g.push(r); else byTime.set(t, [r])
  }
  let candidates: Candidate[] = []
  for (const [timeMs, group] of byTime) {
    const keys = new Set(group.map(clinicalStateKey))
    if (keys.size > 1) { counts.clinical.excludedAmbiguousTimestamp += group.length; continue }
    counts.clinical.sameTimestampCollapsed += group.length - 1
    candidates.push({ timeMs, stateKey: group.length ? clinicalStateKey(group[0]) : '', records: group })
  }

  // 4. Anchor-duplicate rule: within Δ_min before the anchor (strict <) and
  //    identical clinical state to the anchor ⇒ DUPLICATE_OF_ANCHOR.
  candidates = candidates.filter(c => {
    if (anchorMs - c.timeMs < ANCHOR_DUPLICATE_WINDOW_MS && c.stateKey === anchorKey) {
      counts.clinical.excludedDuplicateOfAnchor += c.records.length
      return false
    }
    return true
  })

  // 5. Anchored-start bursts over real time (timestamps are unique now).
  candidates.sort((a, b) => a.timeMs - b.timeMs)
  const bursts: Candidate[][] = []
  for (const c of candidates) {
    const current = bursts[bursts.length - 1]
    if (current && c.timeMs < current[0].timeMs + EVIDENCE_BURST_WINDOW_MS) current.push(c)
    else bursts.push([c])
  }

  // Prediction candidates, by HealthRecord id (only for records that survived).
  const survivingRecordIds = new Set<string>()
  for (const b of bursts) for (const c of b) for (const r of c.records) survivingRecordIds.add(r.id)
  const predsByRecord = new Map<string, Array<{ row: EvidencePredictionRow; bp: number }>>()
  for (const p of input.predictions) {
    if (p.patientId !== patientId || p.healthRecordId === null || !(p.predictedAt.getTime() < anchorMs)) {
      counts.prediction.droppedOutOfScope++
      continue
    }
    if (!survivingRecordIds.has(p.healthRecordId)) { counts.prediction.excludedRecordNotEffective++; continue }
    counts.prediction.candidateRows++
    if (p.modelVersion !== globalModelVersion) { counts.prediction.excludedVersion++; continue }
    // NEW-R row ⇒ ONLY its GLOBAL score; legacy row (status NULL) ⇒ riskScore,
    // which was the global score for every pre-NEW-R prediction.
    const isNewR = p.personalizationStatus !== null
    const raw = isNewR ? p.globalRiskScore : p.riskScore
    const bp = raw === null ? null : scoreToBasisPoints(raw)
    if (bp === null) { counts.prediction.excludedMissingGlobalScore++; continue }
    const list = predsByRecord.get(p.healthRecordId)
    if (list) list.push({ row: p, bp }); else predsByRecord.set(p.healthRecordId, [{ row: p, bp }])
  }

  // 6. Units.
  const units: EvidenceUnit[] = bursts.map(burst => {
    // Within-burst identical-state collapse to the earliest occurrence.
    const seen = new Set<string>()
    const states: EvidenceState[] = []
    for (const c of burst) {
      if (seen.has(c.stateKey)) { counts.clinical.burstCollapsedDuplicates += c.records.length; continue }
      seen.add(c.stateKey)
      const r = c.records[0]
      states.push({
        tDays:   (c.timeMs - anchorMs) / MS_PER_DAY,
        sysBP:   num2(r.sysBP), diaBP: num2(r.diaBP), totChol: num2(r.totChol), glucose: num2(r.glucose),
      })
    }

    // π: the burst's LATEST member candidate that has any compatible
    // prediction; all its values must be exactly equal, otherwise the unit's
    // prediction side is AMBIGUOUS (no fallback to earlier members, no averaging).
    let pi: EvidenceUnit['pi'] = null
    let piState: EvidencePiState | null = null
    let piPredictionIds: string[] = []
    for (let i = burst.length - 1; i >= 0; i--) {
      const c = burst[i]
      const rows = c.records.flatMap(r => predsByRecord.get(r.id) ?? [])
      if (rows.length === 0) continue
      const bps = new Set(rows.map(x => x.bp))
      if (bps.size > 1) { counts.prediction.ambiguousGroups++; break }
      const bp = rows[0].bp
      const sexes = new Set(rows.map(x => x.row.sexUsed))
      const onlySex = sexes.size === 1 ? rows[0].row.sexUsed : null
      const sexUsed = onlySex === 0 || onlySex === 1 ? onlySex : null
      const r = c.records[0]
      pi = { score: bp / 10_000, scoreBp: bp }
      piState = {
        age: r.age, currentSmoker: r.currentSmoker ? 1 : 0, cigsPerDay: r.cigsPerDay,
        BPMeds: r.bpMeds ? 1 : 0, diabetes: r.diabetes ? 1 : 0,
        BMI: num2(r.bmi), heartRate: r.heartRate, sexUsed,
      }
      piPredictionIds = rows.map(x => x.row.id).sort()
      break
    }
    if (pi) counts.prediction.canonicalUnits++

    return {
      tDays: (burst[burst.length - 1].timeMs - anchorMs) / MS_PER_DAY,
      states, pi, piState,
      source: {
        recordIds: burst.flatMap(c => c.records.map(r => r.id)).sort(),
        piPredictionIds,
      },
    }
  })
  counts.clinical.effectiveUnits = units.length

  return {
    personalizationVersion: PERSONALIZATION_VERSION,
    globalModelVersion,
    anchor: { recordId: anchor.id, recordedAtMs: anchorMs },
    units,
    counts,
    evidenceFingerprint: evidenceFingerprint(anchor, globalModelVersion, units),
  }
}

// SHA-256 over a canonical serialization of the evidence actually used:
// policy version, global model version, anchor id + cutoff, and per unit (in
// real time order) its sorted member record ids and, if any, the π basis
// points + sorted contributing prediction ids. Ids are provenance only.
export function evidenceFingerprint(anchor: EvidenceRecordRow, globalModelVersion: string, units: EvidenceUnit[]): string {
  const canonical = JSON.stringify({
    policy: PERSONALIZATION_VERSION,
    globalModelVersion,
    anchorRecordId: anchor.id,
    cutoff: anchor.recordedAt.toISOString(),
    units: units.map(u => ({
      records: u.source.recordIds,
      pi: u.pi ? { bp: u.pi.scoreBp, predictions: u.source.piPredictionIds } : null,
    })),
  })
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// R3 item 37 projection for the future AI request (R4D). Contains NO ids and
// NO absolute timestamps. Not consumed by production code in R4B.
export function toPersonalizationRequest(e: PersonalizationEvidence) {
  return {
    version: e.personalizationVersion,
    raw_counts: e.counts,
    units: e.units.map(u => ({
      t_days: u.tDays,
      states: u.states.map(s => ({ t_days: s.tDays, sysBP: s.sysBP, diaBP: s.diaBP, totChol: s.totChol, glucose: s.glucose })),
      pi: u.pi ? { score: u.pi.score } : null,
      pi_state: u.piState,
    })),
  }
}
