// PRE-R — shared, generic email domain utility, same precedent as
// lib/phone.ts's CanonicalPhoneField/NullableCanonicalPhoneField: a field
// requiring "a normalized, valid email, or an explicit clear" is reusable
// infrastructure, not something that belongs to any one feature module.
//
// This is User.email's contract specifically (the login identity — see
// auth.dto.ts's own comment on why that is a separate concern from
// Paciente.email). PATCH /users/me/profile (user.routes.ts) is the one
// consumer today; auth.dto.ts's RegisterDto keeps its own existing
// RegisterEmailField definition unchanged (PRE-R explicitly does not touch
// registration's backend contract) even though the normalization shape is
// identical — that is a deliberate non-dependency, not an oversight, so
// registration's contract truly stays untouched by this block.
import { z } from 'zod'

export const EMAIL_MESSAGE = 'Invalid email'

// omitted              → leave unchanged (`.optional()`)
// null                  → clear (bypasses the inner schema entirely)
// "" / whitespace-only  → normalized to `null` and cleared, NOT rejected
// valid email           → trimmed + lowercased + persisted
// invalid non-empty     → validation error (EMAIL_MESSAGE)
// Mirrors NullableCanonicalPhoneField's exact preprocess-then-validate shape
// (lib/phone.ts) so both identifier fields share one PATCH contract pattern.
export const NullableCanonicalEmailField = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val
    const trimmed = val.trim()
    return trimmed === '' ? null : trimmed.toLowerCase()
  },
  z.string().max(254, EMAIL_MESSAGE).email(EMAIL_MESSAGE).nullable(),
).optional()
