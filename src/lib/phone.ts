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
