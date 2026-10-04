import { z } from 'zod'
import { toLocalISODate } from '@/lib/timezone'
// Z6-FIX1 — the generic canonical-phone Zod field now lives in lib/phone.ts
// (reused by user.routes.ts too) rather than being defined/owned here.
import { CanonicalPhoneField } from '@/lib/phone'

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
// `CanonicalPhoneField`/`PHONE_MESSAGE` are imported from lib/phone.ts
// above (Z6-FIX1) — this module re-uses them, it does not define them.

// Z6 — patient email contract. Unlike phone, this field has NO pre-existing
// legacy data to accommodate (it is brand new in this migration — every
// Paciente row starts at `email = NULL`), so there is no need for phone's
// own "resend-unchanged-legacy-value" service-layer escape hatch: Zod alone
// can fully own normalization + validation for BOTH Create and Update.
// Contract (§4): trim surrounding whitespace, lowercase before persistence,
// empty/whitespace-only → null, syntactically valid email required
// otherwise, max length 254. `z.preprocess` runs the trim/lowercase/empty→
// null step BEFORE the inner schema's `.max()`/`.email()` checks, so those
// checks only ever see either `null` (bypassed entirely by `.nullable()`)
// or a already-normalized, non-empty string.
export const PATIENT_EMAIL_MESSAGE = 'Invalid email address'
const PatientEmailField = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val
    const trimmed = val.trim()
    return trimmed === '' ? null : trimmed.toLowerCase()
  },
  z.string().max(254, PATIENT_EMAIL_MESSAGE).email(PATIENT_EMAIL_MESSAGE).nullable(),
).optional()

export const CreatePatientDto = z.object({
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
  birthDate: BirthDateField,
  sex:       z.number().int().min(0).max(1),
  curp:      z.string().length(18).optional(),
  phone:     CanonicalPhoneField.optional(),
  // Z6 — optional on Create: omitted or blank → null (no email required to
  // create a patient); a syntactically invalid value is rejected (never
  // silently accepted) — see PatientEmailField above.
  email:     PatientEmailField,
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
  // Z6 — same PATCH semantics as every other nullable field here: omitted
  // → don't touch; null or blank → clear to null; valid → normalize +
  // persist. Unlike phone, no legacy-compat exception is needed (see
  // PatientEmailField's own comment above) — this one field fully owns
  // email validation for both Create and Update.
  email:     PatientEmailField,
  // Z8 — `isActive` REMOVED from this general-purpose DTO. Lifecycle state
  // is no longer settable through the generic PUT /patients/:id — it has
  // its own dedicated, explicit endpoint (PATCH /patients/:id/status,
  // PatientStatusDto below), per Z8's "no endpoint should silently combine
  // two product actions" principle. Confirmed by direct read of
  // EditPatientModal.tsx before this change: it never sent `isActive` in
  // its submit payload, so no existing frontend caller relied on this.
})

// Z8 — Patients-list lifecycle filter. ACTIVE (the default — matches
// today's implicit "doctor opens Patients and sees the active roster"
// expectation) / INACTIVE / ALL. Composes with search/risk exactly like
// every other PatientQueryDto field — see patient.repository.ts::findAll
// for the exact predicate each value maps to. Hidden patients are excluded
// from the result set for EVERY one of these three values, always, at the
// repository layer — never something this DTO or the caller can override
// (there is deliberately no 'HIDDEN'/'INCLUDE_HIDDEN' option here; the only
// way to see a hidden patient is the separate, dedicated hidden-patient
// management surface below).
export const PatientStatusFilter = z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE')

export const PatientQueryDto = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  risk:   z.enum(['LOW', 'MODERATE', 'HIGH']).optional(),
  status: PatientStatusFilter,
})

export const PatientParamDto = z.object({
  id: z.string().uuid('Invalid patient id'),
})

// Z8 — PATCH /patients/:id/status. The ONE explicit, reversible lifecycle
// mutation: `isActive: false` deactivates, `isActive: true` reactivates.
// Never accepts/implies `isHidden` — see PatientVisibilityDto below, the
// separate endpoint for that axis (Z8's "each product action remains
// explicit" principle — this endpoint never silently shows+reactivates a
// hidden patient in one call).
export const PatientStatusDto = z.object({
  isActive: z.boolean(),
})

// Z8 — PATCH /patients/:id/visibility. The ONE explicit, reversible
// visibility mutation: `isHidden: true` hides (only valid for an already-
// INACTIVE, currently-visible patient — see PatientService.hide()'s own
// PatientMustBeInactiveToHideError), `isHidden: false` shows (only valid
// for an already-hidden patient — see PatientService.show()). SHOW never
// sets isActive back to true — reactivation remains a fully separate,
// subsequent PATCH /patients/:id/status call (Z8 §9's required SHOW-then-
// REACTIVATE sequence).
export const PatientVisibilityDto = z.object({
  isHidden: z.boolean(),
})

// Z8 — GET /patients/visibility/hidden (the Settings -> Pacientes hidden
// list) and the visibility-summary counts both scope strictly to
// isActive=false AND isHidden=true for the current doctor — this DTO is
// deliberately minimal (no `risk`, no lifecycle `status` — this surface
// only ever shows hidden patients, there is nothing to filter by lifecycle
// state) per Z8 §17's "minimal patient summary... not another PatientDetail
// implementation" instruction. `search` is included because the existing
// paging/search infrastructure (the same contains/insensitive pattern
// PatientQueryDto.search already uses) is trivially reusable here and the
// hidden list can grow large enough that finding one patient by name is a
// real, not speculative, management need.
export const HiddenPatientQueryDto = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
})

// Z8 — PATCH /patients/inactive/visibility (bulk hide-all-inactive /
// show-all-hidden). Same shape as PatientVisibilityDto — one explicit
// boolean, no partial/mixed semantics — but scoped by the service/
// repository layer to "every currently-eligible row for this doctor" rather
// than one patient id (see PatientService.bulkSetVisibility()).
export const BulkVisibilityDto = z.object({
  isHidden: z.boolean(),
})

export type PatientStatusDtoType     = z.infer<typeof PatientStatusDto>
export type PatientVisibilityDtoType = z.infer<typeof PatientVisibilityDto>
export type HiddenPatientQueryDtoType = z.infer<typeof HiddenPatientQueryDto>
export type BulkVisibilityDtoType    = z.infer<typeof BulkVisibilityDto>

// U5.2 — GET /patients/:id/history query. Whitelist of sortBy is exact and
// closed (z.enum) — never arbitrary field interpolation. Applies only to
// the `records` (HealthRecord) portion of the response; `predictions`
// (unchanged, unpaginated) is untouched by these params.
export const HistoryQueryDto = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(50).default(10),
  // NEW S2E-FIX2 — 'clinicalTime' (default) = effective clinical time:
  // measuredAt for CLINICIAN_ENTERED rows, recordedAt for legacy rows
  // (see patient.repository.ts::getHistory). 'recordedAt' (pure entry
  // time) stays accepted for backward compatibility.
  sortBy:    z.enum(['clinicalTime', 'recordedAt', 'sysBP', 'diaBP', 'totChol', 'glucose', 'bmi']).default('clinicalTime'),
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
