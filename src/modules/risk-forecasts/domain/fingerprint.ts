// NEW S2B — deterministic S input fingerprint (schema S-FP-1).
//
// SHA-256 (hex) over a canonical JSON ARRAY (positional — no object keys, so
// no dependence on property insertion order). Every scalar is a string:
//   instants  → ISO-8601 with milliseconds ("2026-10-02T18:30:00.000Z")
//   dates     → "YYYY-MM-DD"
//   booleans  → "1" / "0"
//   integers  → base-10 integer text
//   decimals  → exact normalized decimal text (240.00 → "240", 9.50 → "9.5")
//   null      → JSON null
// Records: ALL REAL HealthRecords (usable or not), sorted by the S clinical
// order (effective clinical instant, recordedAt, id) — never by DB order.
// Never included: Prediction rows, risk scores, forecasts, provenance JSON,
// any numeric bridge state.

import { createHash } from 'crypto'
import { FINGERPRINT_SCHEMA_VERSION, S_POLICY_VERSIONS } from './constants'
import { assertCalendarDate, sortByClinicalOrder } from './clinicalTime'
import { canonicalDecimal } from './validity'
import { SInputContractError, type SPlanInput } from './types'

const b = (v: boolean) => (v ? '1' : '0')
const int = (v: number, what: string) => {
  if (!Number.isInteger(v)) throw new SInputContractError(`fingerprint: ${what} is not an integer (${v})`)
  return String(v)
}
const iso = (d: Date) => d.toISOString()

export function canonicalFingerprintPayload(input: SPlanInput): string {
  const { patient, model } = input
  assertCalendarDate(patient.birthDate)
  const records = sortByClinicalOrder(input.records).map(r => [
    r.id,
    iso(r.recordedAt),
    r.measuredAt === null ? null : iso(r.measuredAt),
    r.clinicalTimeSource,
    int(r.age, 'age'),
    b(r.currentSmoker),
    int(r.cigsPerDay, 'cigsPerDay'),
    b(r.bpMeds),
    b(r.diabetes),
    canonicalDecimal(r.totChol),
    canonicalDecimal(r.sysBP),
    canonicalDecimal(r.diaBP),
    canonicalDecimal(r.bmi),
    canonicalDecimal(r.glucose),
  ])
  const bridge = input.bridgeIdentity
    ? [input.bridgeIdentity.bridgeStateId, input.bridgeIdentity.bridgeVersion,
       input.bridgeIdentity.personalizationVersion, input.bridgeIdentity.modelVersion]
    : null
  const payload = [
    FINGERPRINT_SCHEMA_VERSION,
    ['patient', patient.patientId, patient.birthDate, String(patient.sex), b(patient.isActive), b(patient.isHidden)],
    ['model', model.modelVersion, int(model.eligibleAgeRange.min, 'age min'), int(model.eligibleAgeRange.max, 'age max')],
    ['policies', S_POLICY_VERSIONS.sVersion, S_POLICY_VERSIONS.clinicalTimePolicyVersion,
      S_POLICY_VERSIONS.cadencePolicyVersion, S_POLICY_VERSIONS.featurePolicyVersion],
    ['bridge', bridge],
    ['records', records],
  ]
  return JSON.stringify(payload)
}

export function computeInputFingerprint(input: SPlanInput): string {
  return createHash('sha256').update(canonicalFingerprintPayload(input), 'utf8').digest('hex')
}
