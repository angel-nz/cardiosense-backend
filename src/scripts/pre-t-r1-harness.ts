import assert from 'assert'
import { Prisma } from '@prisma/client'
import { buildPersonalizationEvidence, type EvidencePredictionRow, type EvidenceRecordRow } from '@/modules/predictions/personalization/evidence.builder'
import { PERSONALIZATION_VERSION } from '@/modules/predictions/personalization/personalization.constants'
import { evaluateBridgeCompatibility } from '@/modules/risk-forecasts/bridge/bridge.compatibility'
import { shouldCaptureBridge } from '@/modules/risk-forecasts/bridge/bridge.capture'
import { BRIDGE_VERSION } from '@/modules/risk-forecasts/bridge/bridge.constants'
import {
  S_VERSION, CADENCE_POLICY_VERSION, FEATURE_POLICY_VERSION,
  SEQ_WEIGHT_ORDINARY_REAL, SEQ_WEIGHT_LATEST_REAL, SEQ_WEIGHT_SIMULATED,
} from '@/modules/risk-forecasts/domain/constants'
import type { SRealRecordInput } from '@/modules/risk-forecasts/domain/types'

const D = (s: string) => new Date(s)
const patientId = 'patient-r1'
const model = 'Skorp-Beta-0.2'

function rec(id: string, measuredAt: Date | null, recordedAt: Date, overrides: Partial<EvidenceRecordRow> = {}) {
  return {
    id, patientId, measuredAt, clinicalTimeSource: measuredAt ? 'CLINICIAN_ENTERED' : 'LEGACY_ENTRY_TIME',
    age: 58, currentSmoker: false, cigsPerDay: 0, bpMeds: false, diabetes: false,
    totChol: new Prisma.Decimal(220), sysBP: new Prisma.Decimal(140), diaBP: new Prisma.Decimal(85),
    bmi: new Prisma.Decimal(27), glucose: new Prisma.Decimal(100),
    recordedAt, ...overrides,
  } as EvidenceRecordRow & { recordedAt: Date }
}
function pred(id: string, recordId: string, globalRiskScore = 0.20, extra: Record<string, unknown> = {}) {
  return {
    id, patientId, healthRecordId: recordId, riskScore: new Prisma.Decimal(0.31),
    globalRiskScore: new Prisma.Decimal(globalRiskScore), personalizationStatus: 'INDIVIDUALIZED',
    modelVersion: model, sexUsed: 1, ...extra,
  } as EvidencePredictionRow & Record<string, unknown>
}
function build(anchor: ReturnType<typeof rec>, priorRecords: ReturnType<typeof rec>[], predictions: ReturnType<typeof pred>[] = []) {
  return buildPersonalizationEvidence({ patientId, anchor, priorRecords, predictions, globalModelVersion: model, eligibleAgeRange: { min: 32, max: 81 } })
}

// Case A — records entered together but measured in Jul/Aug/Sep/Oct.
const anchor = rec('oct', D('2026-10-04T12:00:00Z'), D('2026-10-05T10:03:00Z'))
const july = rec('jul', D('2026-07-06T12:00:00Z'), D('2026-10-05T10:00:00Z'))
const aug  = rec('aug', D('2026-08-05T12:00:00Z'), D('2026-10-05T10:01:00Z'), { sysBP: new Prisma.Decimal(141) })
const sep  = rec('sep', D('2026-09-04T12:00:00Z'), D('2026-10-05T10:02:00Z'), { sysBP: new Prisma.Decimal(142) })
let e = build(anchor, [july, aug, sep], [pred('p-jul','jul',0.18), pred('p-aug','aug',0.19), pred('p-sep','sep',0.20)])
assert.equal(PERSONALIZATION_VERSION, 'R-BPBC-3')
assert.equal(e.units.length, 3)
assert.deepEqual(e.units.map(u => u.source.recordIds[0]), ['jul','aug','sep'])
assert.ok(e.units.every(u => u.tDays < 0))

// Case B — recorded order conflicts with measured order.
const a = rec('A', D('2026-09-30T12:00:00Z'), D('2026-10-01T12:00:00Z'))
const b = rec('B', D('2026-09-01T12:00:00Z'), D('2026-10-02T12:00:00Z'), { sysBP: new Prisma.Decimal(139) })
e = build(anchor, [a,b])
assert.deepEqual(e.units.map(u => u.source.recordIds[0]), ['B','A'])

// Case C — clinical future is excluded even when recorded earlier.
const future = rec('future', D('2026-11-01T12:00:00Z'), D('2026-09-01T12:00:00Z'))
e = build(anchor, [future])
assert.equal(e.units.length, 0); assert.equal(e.counts.clinical.droppedOutOfScope, 1)

// Case D — equal measuredAt is not causally prior.
const equal = rec('equal', D('2026-10-04T12:00:00Z'), D('2026-09-01T12:00:00Z'))
e = build(anchor, [equal])
assert.equal(e.units.length, 0); assert.equal(e.counts.clinical.droppedOutOfScope, 1)

// Case E — measuredAt NULL / legacy is not R evidence.
const legacy = rec('legacy', null, D('2026-07-01T12:00:00Z'))
e = build(anchor, [legacy])
assert.equal(e.units.length, 0); assert.equal(e.counts.clinical.excludedUnmeasuredClinicalTime, 1)

// Burst policy — use measuredAt, never recordedAt.
const m1 = rec('m1', D('2026-08-01T12:00:00Z'), D('2026-10-05T10:00:00Z'))
const m2 = rec('m2', D('2026-09-01T12:00:00Z'), D('2026-10-05T10:00:05Z'), { sysBP: new Prisma.Decimal(143) })
e = build(anchor, [m1,m2]); assert.equal(e.units.length, 2)
const c1 = rec('c1', D('2026-09-01T12:00:00Z'), D('2026-09-01T12:00:00Z'))
const c2 = rec('c2', D('2026-09-01T12:30:00Z'), D('2026-10-01T12:00:00Z'), { sysBP: new Prisma.Decimal(144) })
e = build(anchor, [c1,c2]); assert.equal(e.units.length, 1)

const hist = rec('hist', D('2026-09-01T12:00:00Z'), D('2026-09-01T12:00:00Z'))
e = build(anchor, [hist], [
  pred('old-model','hist',0.11,{modelVersion:'Skorp-Beta-0.1', personalizationVersion:'R-BPBC-2'}),
  pred('beta02-r2','hist',0.22,{personalizationVersion:'R-BPBC-2'}),
])
assert.equal(e.counts.prediction.excludedVersion, 1)
assert.equal(e.units[0].pi?.score, 0.22)
assert.notEqual(e.units[0].pi?.score, 0.31)

function srec(id: string, measuredAt: Date | null, recordedAt: Date): SRealRecordInput {
  return {
    id, recordedAt, measuredAt, clinicalTimeSource: measuredAt ? 'CLINICIAN_ENTERED' : 'LEGACY_ENTRY_TIME',
    age: 58, currentSmoker: false, cigsPerDay: 0, bpMeds: false, diabetes: false,
    totChol: 220, sysBP: 140, diaBP: 85, bmi: 27, glucose: 100,
  }
}
const sAnchor = srec('anchor', D('2026-10-04T12:00:00Z'), D('2026-10-05T12:00:00Z'))
const bridgeBase = {
  id:'bridge', predictionId:'prediction', healthRecordId:'anchor', patientId, personalizationVersion:'R-BPBC-3',
  modelVersion:model, sexUsed:1, anchorAge:58, status:'INDIVIDUALIZED' as const, appliedLogit:0.1,
  bridgeVersion:BRIDGE_VERSION, typedReadBitExact:true,
}
const candidate = { canonicalPredictionId:'prediction', bridge:bridgeBase }
const patient = { patientId, birthDate:'1968-01-01', sex:1 }
let bc = evaluateBridgeCompatibility({patient, anchor:sAnchor, records:[sAnchor], currentModelVersion:model, expectedPersonalizationVersion:PERSONALIZATION_VERSION, candidate})
assert.equal(bc.compatible, true)
bc = evaluateBridgeCompatibility({patient, anchor:sAnchor, records:[sAnchor], currentModelVersion:model, expectedPersonalizationVersion:PERSONALIZATION_VERSION,
  candidate:{canonicalPredictionId:'prediction', bridge:{...bridgeBase, personalizationVersion:'R-BPBC-2'}}})
assert.deepEqual(bc, {compatible:false, reason:'BRIDGE_PERSONALIZATION_VERSION_MISMATCH', interpretation:'GLOBAL'})
const concurrent = srec('equal2', D('2026-10-04T12:00:00Z'), D('2026-09-01T12:00:00Z'))
bc = evaluateBridgeCompatibility({patient, anchor:sAnchor, records:[sAnchor,concurrent], currentModelVersion:model, expectedPersonalizationVersion:PERSONALIZATION_VERSION, candidate})
assert.deepEqual(bc, {compatible:false, reason:'R_TIME_AXIS_MISMATCH', interpretation:'GLOBAL'})
const legacyS = srec('legacyS', null, D('2026-10-06T12:00:00Z'))
bc = evaluateBridgeCompatibility({patient, anchor:sAnchor, records:[sAnchor,legacyS], currentModelVersion:model, expectedPersonalizationVersion:PERSONALIZATION_VERSION, candidate})
assert.equal(bc.compatible, true)
assert.equal(shouldCaptureBridge({...bridgeBase, personalizationStatus:'GLOBAL_INSUFFICIENT_HISTORY', bridgeAppliedLogit:null, personalizationVersion:PERSONALIZATION_VERSION}), false)
bc = evaluateBridgeCompatibility({patient, anchor:sAnchor, records:[sAnchor], currentModelVersion:model, expectedPersonalizationVersion:PERSONALIZATION_VERSION, candidate:null})
assert.deepEqual(bc, {compatible:false, reason:'BRIDGE_MISSING', interpretation:'GLOBAL'})

assert.equal(S_VERSION, 'S-3')
assert.equal(CADENCE_POLICY_VERSION, 'S-CAD-3')
assert.equal(FEATURE_POLICY_VERSION, 'S-FEAT-SEQUENTIAL-ROBUST-2')
assert.deepEqual([SEQ_WEIGHT_ORDINARY_REAL, SEQ_WEIGHT_LATEST_REAL, SEQ_WEIGHT_SIMULATED], [1, 1.25, 0.5])

console.log('PRE-T-R1 harness: PASS')
