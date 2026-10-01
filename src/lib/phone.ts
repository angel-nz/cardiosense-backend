// V6.2 — backend phone domain utility. Wraps libphonenumber-js (full/"max"
// metadata build — the default `libphonenumber-js` import — since backend
// validation is the authoritative boundary and correctness matters more
// here than bundle size, unlike the frontend's `/min` build).
//
// CardioSense's canonical Patient.phone contract (V6.1 §9/§10, V6.2 §1):
//   - a single string, no separate country-code/national-number columns;
//   - E.164-style: leading '+', country calling code, national significant
//     number, NO display spaces/punctuation;
//   - no extension support — CardioSense does not need it and this parser
//     never accepts one;
//   - "canonical equality" is required, not mere parseability: the
//     submitted string must equal `parsePhoneNumberFromString(value)
//     .format('E.164')` exactly. A syntactically parseable but
//     differently-formatted value (e.g. "+52 33 1234 5678" with spaces) is
//     REJECTED as a new/changed write — see isCanonicalPhone below.
import { z } from 'zod'
import { parsePhoneNumberFromString } from 'libphonenumber-js'

// Fast structural guard only — NOT a source of validity/country truth.
// libphonenumber-js remains the sole authority for parsing/validity; this
// regex exists purely to short-circuit obviously-wrong input (no leading
// '+', letters, spaces) without invoking the parser, per V6.2 §7's
// instruction that only a minimal leading-'+' guard may be regex-based.
const STRUCTURAL_GUARD = /^\+[1-9]\d{1,14}$/

// True only when `value` is BOTH a valid phone number AND already in its
// own canonical E.164 form — i.e. re-formatting it changes nothing. This
// is the "canonical equality" check V6.2 §5 requires: parses-but-differs
// (e.g. contains spaces, or a nationally-formatted string that happens to
// also start with '+') must be rejected, not silently accepted/reformatted.
export function isCanonicalPhone(value: string): boolean {
  if (!STRUCTURAL_GUARD.test(value)) return false
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed) return false
  if (!parsed.isValid()) return false
  // No extension support — reject outright if libphonenumber-js parsed one
  // out of the input (it never would from a plain E.164 string, but this
  // keeps the contract explicit rather than relying on absence-by-accident).
  if (parsed.ext) return false
  return parsed.format('E.164') === value
}

// Parses and validates without the canonical-equality requirement — used
// only where syntactic parseability/country-inference is what's needed
// (kept for completeness/future callers; V6.2's own DTO/service logic below
// uses isCanonicalPhone directly, since "valid" is not "canonical" here).
export function parseValidPhone(value: string) {
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed || !parsed.isValid() || parsed.ext) return null
  return parsed
}

// Z6-FIX1 — generic Zod wrapper around isCanonicalPhone above, moved here
// (out of modules/patients/patient.dto.ts) so "a field requiring a
// canonical E.164 phone" is reusable infrastructure, not something that
// semantically belongs to the Patients module. patient.dto.ts (Paciente.
// phone, Create) and user.routes.ts (Medico.phone, PATCH /me/profile) both
// consume this — neither defines its own parallel phone validator.
export const PHONE_MESSAGE = 'Phone must be a valid canonical international number (E.164 format, e.g. +523312345678), with no spaces or punctuation'
export const CanonicalPhoneField = z.string().max(20).superRefine((value, ctx) => {
  if (!isCanonicalPhone(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: PHONE_MESSAGE })
  }
})

// Z6-FIX1 — nullable variant implementing the FULL Z6 PATCH contract for a
// field whose backend validation must stand on its own (not merely rely on
// the frontend always converting a blank UI state to `null` before it ever
// reaches here):
//   omitted              → leave unchanged (`.optional()`)
//   null                  → clear (bypasses the inner schema entirely)
//   "" / whitespace-only  → normalized to `null` and cleared, NOT rejected
//   valid canonical E.164 → persisted
//   invalid non-empty     → validation error (PHONE_MESSAGE)
// `z.preprocess` runs the blank→null normalization BEFORE
// CanonicalPhoneField's own `.max()`/superRefine checks, so those only ever
// see either `null` (short-circuited by `.nullable()`) or an already
// non-blank, trimmed string — E.164 validation itself is never weakened.
// Currently consumed by user.routes.ts's doctor-phone PATCH field; Paciente
// Create/Update keep their own existing, documented phone semantics
// unchanged (see patient.dto.ts/patient.service.ts) — this export is
// additive, not a replacement for those.
export const NullableCanonicalPhoneField = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val
    const trimmed = val.trim()
    return trimmed === '' ? null : trimmed
  },
  CanonicalPhoneField.nullable(),
).optional()
