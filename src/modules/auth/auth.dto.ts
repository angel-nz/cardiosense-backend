import { z } from 'zod'
import { CanonicalPhoneField } from '@/lib/phone'

// Z6-R1 — doctor registration identifier contract. This is User.email (the
// login identity) — a completely separate concern from Paciente.email
// (patients/patient.dto.ts's PatientEmailField, patient CONTACT
// information, no auth role at all — see §27 of the Z6-R1 brief). The
// normalization shape (trim, lowercase, blank → null, max 254, valid
// syntax) mirrors PatientEmailField's own precedent, but this is an
// independent field on an independent column/constraint (User.email is
// unique and is one of the two things that can authenticate a doctor) —
// never imported from patient.dto.ts, never sharing its implementation.
// `z.preprocess` normalizes BEFORE the inner schema's `.max()`/`.email()`
// checks, so those only ever see either `null` (bypassed by `.nullable()`)
// or an already-normalized, non-empty string.
export const REGISTER_EMAIL_MESSAGE = 'Invalid email'
const RegisterEmailField = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val
    const trimmed = val.trim()
    return trimmed === '' ? null : trimmed.toLowerCase()
  },
  z.string().max(254, REGISTER_EMAIL_MESSAGE).email(REGISTER_EMAIL_MESSAGE).nullable(),
).optional()

// Z6-R1 — doctor registration phone. Every registration is a BRAND-NEW
// Medico row (no pre-existing phone to compare against, exactly like
// CreatePatientDto's own phone field — see patient.dto.ts's comment on
// that precedent), so this can safely require full canonical-equality for
// any value actually supplied, with no legacy-compat exception needed
// (that exception exists only for Paciente.phone's pre-V6.2 legacy data,
// which has no equivalent here). blank/whitespace → null (not provided),
// same convention as RegisterEmailField above. Reuses the one shared
// CanonicalPhoneField (lib/phone.ts) — no second phone parser.
const RegisterPhoneField = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val
    const trimmed = val.trim()
    return trimmed === '' ? null : trimmed
  },
  CanonicalPhoneField.nullable(),
).optional()

// Z6-R1 §1/§8 — the product invariant ("every MEDICO account has email !=
// null OR phone != null") is enforced here, at the DTO layer, via
// superRefine — the one place both normalized fields are available
// together before the service layer ever runs. Scoped to role === MEDICO
// only: an ADMIN account has no Medico row and can never have a phone at
// all, so ADMIN registration keeps requiring email exactly as before this
// block (unchanged pre-existing behavior, never loosened). The issue is
// attached to BOTH paths (`email`/`phone`) so RegisterPage can show the
// group requirement next to whichever field makes sense, per the brief's
// own "neither individually marked mandatory, but the group requirement
// must be clear" instruction (§21).
export const AT_LEAST_ONE_IDENTIFIER_MESSAGE = 'Provide an email address or a phone number.'

// Z6-R1 — extracted to its own named export (was previously only reachable
// via `RegisterDto.shape.password`). RegisterDto is now a `ZodEffects`
// (the `.superRefine()` below wraps the plain object), and `ZodEffects` has
// no `.shape` — `user.routes.ts`'s ChangePasswordDto (Y5.1 §6) depended on
// `RegisterDto.shape.password` to reuse this exact policy, so that
// dependency now points at this export directly instead. Policy itself
// (min 8, one uppercase, one digit) is completely unchanged.
export const RegisterPasswordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Must contain uppercase')
  .regex(/[0-9]/, 'Must contain a number')

export const RegisterDto = z.object({
  email: RegisterEmailField,
  phone: RegisterPhoneField,
  password: RegisterPasswordField,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: z.enum(['MEDICO', 'ADMIN']).default('MEDICO'),
  // Doctor extra fields
  cedulaProfesional: z.string().optional(),
  especialidad: z.string().optional(),
  hospital: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.role !== 'MEDICO') {
    // Unchanged pre-existing contract for non-MEDICO (ADMIN) registration
    // — phone is not a thing an ADMIN account can ever have, so it is
    // never considered a substitute for email here.
    if (!data.email) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: REGISTER_EMAIL_MESSAGE, path: ['email'] })
    }
    return
  }
  if (!data.email && !data.phone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: AT_LEAST_ONE_IDENTIFIER_MESSAGE, path: ['email'] })
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: AT_LEAST_ONE_IDENTIFIER_MESSAGE, path: ['phone'] })
  }
})

// Z6-R1-FIX1 §1 — login no longer GUESSES whether `identifier` is an email
// or a phone from its shape (the previous `identifier.startsWith('+')`
// heuristic, now removed entirely from auth.service.ts). The Login UI
// already has an explicit Correo/Teléfono mode selector (LoginPage.tsx), so
// the client's own already-known intent is transmitted directly as
// `method` — a discriminated union, not a shared shape with inference
// layered on top. Each branch owns its own normalization/validation,
// exactly matching §1's required semantics:
//   EMAIL — trim, lowercase, validated as a real email (same convention as
//     RegisterEmailField above, minus the blank→null allowance — login
//     has no "not provided" case, the field is simply required).
//   PHONE — validated as canonical E.164 via the one shared
//     CanonicalPhoneField (lib/phone.ts) — no second phone parser, no
//     separate regex.
// auth.service.ts switches on `dto.method` directly; there is no
// leading-'+'/`@`/regex inference left anywhere in the login path.
const LoginEmailDto = z.object({
  method: z.literal('EMAIL'),
  identifier: z.preprocess(
    (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
    z.string().min(1, 'Required').email('Invalid email'),
  ),
  password: z.string().min(1),
})

const LoginPhoneDto = z.object({
  method: z.literal('PHONE'),
  identifier: CanonicalPhoneField,
  password: z.string().min(1),
})

export const LoginDto = z.discriminatedUnion('method', [LoginEmailDto, LoginPhoneDto])

// Y5.2 — RefreshDto (a body { refreshToken }) removed: POST /auth/refresh no
// longer accepts or expects a request body at all. The refresh credential
// now travels exclusively as the `cardiosense_refresh` HttpOnly cookie (see
// lib/cookies.ts) — a body-carried refresh token would defeat the entire
// point of moving it out of JS-reachable storage.

export type RegisterDtoType = z.infer<typeof RegisterDto>
export type LoginDtoType    = z.infer<typeof LoginDto>
