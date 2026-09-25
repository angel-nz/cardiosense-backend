import { z } from 'zod'
import { toLocalISODate } from '@/lib/timezone'
import { isCanonicalPhone } from '@/lib/phone'

// U8.6B — patient birthDate DATA-SANITY rule (not model eligibility): a
// real calendar date that is not after today in the business timezone
// (America/Mexico_City). Today is allowed. No minimum/maximum age is
// imposed here — patients of any age remain valid; whether a prediction is
// possible is decided separately by the model's eligibility contract.
// Pure and `now`-injectable so it can be verified deterministically.
export function birthDateIssue(value: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Format: YYYY-MM-DD'
  const [y, m, d] = value.split('-').map(Number)
  const probe = new Date(0)
  probe.setUTCFullYear(y, m - 1, d)
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return 'Invalid calendar date'
  }
  if (value > toLocalISODate(now)) return 'Birth date cannot be in the future'
  return null
}

// Shared by create and update — one rule, one place.
const BirthDateField = z.string().superRefine((value, ctx) => {
  const issue = birthDateIssue(value)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue })
})

// V6.2 §1/§5/§9 — canonical phone contract. Used ONLY on Create, where
// there is no pre-existing Patient row to compare against, so full
// canonical-equality enforcement at the DTO layer is safe and correct: any
// submitted phone must already be `parsePhoneNumberFromString(value)
// .format('E.164') === value` (see lib/phone.ts::isCanonicalPhone) —
// display-formatted ("+52 33 1234 5678"), malformed, impossible, or
// arbitrary-text values are all rejected here, before the service layer.
export const PHONE_MESSAGE = 'Phone must be a valid canonical international number (E.164 format, e.g. +523312345678), with no spaces or punctuation'
const CanonicalPhoneField = z.string().max(20).superRefine((value, ctx) => {
  if (!isCanonicalPhone(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: PHONE_MESSAGE })
  }
})

export const CreatePatientDto = z.object({
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
  birthDate: BirthDateField,
  sex:       z.number().int().min(0).max(1),
  curp:      z.string().length(18).optional(),
  phone:     CanonicalPhoneField.optional(),
})

export const UpdatePatientDto = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName:  z.string().min(1).max(100).optional(),
  // U4.2A — extended to accept curp/birthDate/sex (all already existed in
  // Prisma/CreatePatientDto — no migration). curp/phone use
  // .nullable().optional(): omitted means "don't touch this field", `null`
  // means "clear it" (both columns are nullable in Prisma) — an empty
  // string is never sent by the frontend (see EditPatientModal), so this
  // DTO doesn't need to special-case it. birthDate/sex keep the exact same
  // validation strictness CreatePatientDto already uses — no new, stricter
  // policy introduced for Update alone.
  birthDate: BirthDateField.optional(),
  sex:       z.number().int().min(0).max(1).optional(),
  curp:      z.string().length(18).nullable().optional(),
  // V6.2 §3/§10 — deliberately NOT `CanonicalPhoneField` here. The
  // `validate()` middleware runs before the controller/service ever see
  // req.body, so a DTO-level refinement has no access to the currently
  // persisted Patient — it cannot distinguish "doctor resent the existing
  // legacy phone unchanged" (must be accepted — V6.2 §4) from "doctor
  // typed a genuinely new invalid phone" (must be rejected — V6.2 §5).
  // Only a syntactic sanity bound (string, ≤20 chars, matching the
  // pre-existing DTO shape) is enforced here; canonical-format validation
  // for an ACTUALLY CHANGED value is enforced in PatientService.update()
  // (patient.service.ts), which has the current row to compare against.
  // See V6.2 report §1/§2/§10 for the full audit and rationale.
  phone:     z.string().max(20).nullable().optional(),
  isActive:  z.boolean().optional(),
})

export const PatientQueryDto = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  risk:   z.enum(['LOW', 'MODERATE', 'HIGH']).optional(),
})

export const PatientParamDto = z.object({
  id: z.string().uuid('Invalid patient id'),
})

// U5.2 — GET /patients/:id/history query. Whitelist of sortBy is exact and
// closed (z.enum) — never arbitrary field interpolation. Applies only to
// the `records` (HealthRecord) portion of the response; `predictions`
// (unchanged, unpaginated) is untouched by these params.
export const HistoryQueryDto = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(50).default(10),
  sortBy:    z.enum(['recordedAt', 'sysBP', 'diaBP', 'totChol', 'glucose', 'bmi']).default('recordedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  from:      z.string().optional(),
  to:        z.string().optional(),
  // U8.2B — optional deep-link target resolution. When present, the
  // backend ignores the client's own `page` and instead resolves which
  // page actually contains this HealthRecord under the current
  // sortBy/sortOrder/filters, returning that page instead. Normal callers
  // that omit this continue getting exactly the pre-existing behavior.
  targetId:  z.string().uuid('Invalid target id').optional(),
})

export type CreatePatientDtoType = z.infer<typeof CreatePatientDto>
export type UpdatePatientDtoType = z.infer<typeof UpdatePatientDto>
export type PatientQueryDtoType  = z.infer<typeof PatientQueryDto>
export type HistoryQueryDtoType  = z.infer<typeof HistoryQueryDto>
