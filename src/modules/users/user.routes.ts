import { Router } from 'express'
import type { Response, NextFunction } from 'express'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { Prisma } from '@prisma/client'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { authorize } from '@/middlewares/authorize'
import { validate } from '@/middlewares/validate'
import { passwordChangeLimiter, avatarUploadLimiter } from '@/middlewares/rateLimiter'
import { prisma } from '@/config/prisma'
import { env } from '@/config/env'
import {
  NotFoundError, DuplicateCedulaError, DuplicatePhoneError, DuplicateEmailError, InvalidCurrentPasswordError, PasswordUnchangedError,
  FileTooLargeError, InvalidImageError, NoAvatarError, AvatarStorageUnavailableError,
  LastLoginIdentifierError,
} from '@/lib/errors'
// Z6-R1 — RegisterDto is now a ZodEffects (wrapped in `.superRefine()` for
// the email-or-phone invariant) and no longer exposes `.shape`; the
// password-policy schema this file reuses (Y5.1 §6) is imported directly
// from its own named export instead of via `RegisterDto.shape.password`.
import { RegisterPasswordField } from '@/modules/auth/auth.dto'
// Z6-FIX1 — reuses lib/phone.ts's shared NullableCanonicalPhoneField (a
// generic phone validator, not something owned by the Patients module)
// rather than importing from patient.dto.ts or defining a second, parallel
// phone validator. Medico.phone is brand new in this migration (no
// pre-existing legacy data), so — unlike Paciente.phone — no service-layer
// "resend-unchanged-legacy-value" escape hatch is needed: this one field
// fully owns the omitted/null/blank/valid/invalid contract on its own.
import { NullableCanonicalPhoneField } from '@/lib/phone'
// PRE-R — shared email-field infrastructure, same precedent/rationale as
// NullableCanonicalPhoneField immediately above (generic, reusable domain
// validator in lib/, not owned by any one feature). User.email becomes
// editable through this route as of PRE-R — see UpdateMyProfileDto below.
import { NullableCanonicalEmailField } from '@/lib/email'
import { revokeSession, revokeOtherSessions, clearRefreshCookie } from '@/lib/session'
import { disconnectSessionSockets, disconnectOtherSessionSockets } from '@/socket/socketServer'
import { normalizeAvatarUpload } from '@/modules/users/avatar.pipeline'
import type { AuthRequest } from '@/types'
import { toPublicDoctorProfile, toPublicRole } from '@/lib/publicIdentity'

const router = Router()
const auth   = authenticate

// GET /users — admin only
router.get('/',
  auth,
  authorize('ADMIN'),
  async (_req, res: Response, next: NextFunction) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, isActive: true, createdAt: true,
          doctor: { select: { specialty: true, hospital: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
      res.json(users.map(user => ({
        ...user,
        role: toPublicRole(user.role),
        medico: user.doctor ? { especialidad: user.doctor.specialty, hospital: user.doctor.hospital } : null,
        doctor: undefined,
      })))
    } catch (err) { next(err) }
  },
)

// ─── Notification preferences (Bloque N-B, rebuilt in Y4) ─────────
// Scoped to `me` by design, not `/:id`: these preferences are inherently
// the authenticated user's own — there is no legitimate case for reading or
// editing another user's. Using `me` structurally removes any chance of
// passing someone else's id, so no ownership check is needed (unlike the
// self-or-admin checks on the /:id routes below).
// Declared before '/:id' for clarity — there is no actual conflict, since
// '/me/notification-preferences' is two segments and '/:id' matches one.
//
// Y4 — final Phase-Y contract: three independent realtime-delivery toggles
// (highRiskRealtime/moderateRiskRealtime/anomalyRealtime), replacing the
// obsolete highRiskAlerts/weeklySummary pair. These settings gate ONLY the
// optional `new_alert` Socket.IO delivery in alerts/alert.service.ts — they
// never affect Alert persistence (see realtimeNotification.ts).
//
// Z5 — three more realtime-delivery toggles, one per Configurable
// Information Alert event, same gating contract exactly. Defaulted to
// `true` here for the exact same lazy-no-row case the three Y4 fields
// already cover (a user with no NotificationPreference row yet) — the
// schema column default (@default(true), schema.prisma) independently
// covers the "row exists but this specific new column predates it" case
// (a user who saved preferences before Z5 shipped); both defaults agree,
// deliberately, unlike interfaceSize's documented divergence above.
//
// Z6-R2 §5 — the doctor-profile realtime toggle that used to sit alongside
// these three was removed entirely (not merely defaulted off): the one
// event it gated no longer exists as a product decision — there is nothing
// left for that toggle to control. Exactly three Z5 information toggles
// remain.
const NOTIFICATION_PREFERENCE_DEFAULTS = {
  highRiskRealtime:     true,
  moderateRiskRealtime: true,
  anomalyRealtime:      true,
  patientCreatedRealtime:      true,
  patientUpdatedRealtime:      true,
  healthRecordCreatedRealtime: true,
}

const NOTIFICATION_PREFERENCE_SELECT = {
  highRiskRealtime: true, moderateRiskRealtime: true, anomalyRealtime: true,
  patientCreatedRealtime: true, patientUpdatedRealtime: true,
  healthRecordCreatedRealtime: true,
  updatedAt: true,
}

// GET /users/me/notification-preferences
router.get('/me/notification-preferences',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const prefs = await prisma.notificationPreference.findUnique({
        where:  { userId },
        select: NOTIFICATION_PREFERENCE_SELECT,
      })
      // Lazy: a user who has never saved preferences has no row yet. Return
      // the schema defaults instead of 404 — GET must never fail just because
      // the row doesn't exist. updatedAt is null there, which is honest:
      // nothing has been saved yet. No row is created just because GET was
      // called (Y4 §12) — the lazy pattern from before Y4 is preserved as-is.
      if (!prefs) {
        res.json({ ...NOTIFICATION_PREFERENCE_DEFAULTS, updatedAt: null })
        return
      }
      res.json(prefs)
    } catch (err) { next(err) }
  },
)

// PATCH /users/me/notification-preferences
// Strict DTO: only the six current realtime toggles (three Y4 risk/
// anomaly + three Z5 information, post-Z6-R2). Obsolete keys
// (highRiskAlerts, weeklySummary, and — as of Z6-R2 — the retired
// doctor-profile realtime toggle) and any unsupported channel (email,
// push, sms, sound) are rejected by `.strict()` before this handler ever
// runs — same 400 VALIDATION_ERROR path as an unrecognized key always
// took.
const UpdateNotificationPreferencesDto = z.object({
  highRiskRealtime:     z.boolean().optional(),
  moderateRiskRealtime: z.boolean().optional(),
  anomalyRealtime:      z.boolean().optional(),
  patientCreatedRealtime:      z.boolean().optional(),
  patientUpdatedRealtime:      z.boolean().optional(),
  healthRecordCreatedRealtime: z.boolean().optional(),
}).strict()

router.patch('/me/notification-preferences',
  auth,
  validate(UpdateNotificationPreferencesDto),
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const {
        highRiskRealtime, moderateRiskRealtime, anomalyRealtime,
        patientCreatedRealtime, patientUpdatedRealtime,
        healthRecordCreatedRealtime,
      } = req.body
      // Explicit `!== undefined` (not `&&`) so an explicit `false` is
      // persisted rather than skipped — unlike the string fields in
      // PATCH /:id below, where falsy legitimately means "not provided".
      const data = {
        ...(highRiskRealtime     !== undefined && { highRiskRealtime }),
        ...(moderateRiskRealtime !== undefined && { moderateRiskRealtime }),
        ...(anomalyRealtime      !== undefined && { anomalyRealtime }),
        ...(patientCreatedRealtime      !== undefined && { patientCreatedRealtime }),
        ...(patientUpdatedRealtime      !== undefined && { patientUpdatedRealtime }),
        ...(healthRecordCreatedRealtime !== undefined && { healthRecordCreatedRealtime }),
      }

      const prefs = await prisma.notificationPreference.upsert({
        where:  { userId },
        update: data,
        create: { userId, ...data },
        select: NOTIFICATION_PREFERENCE_SELECT,
      })
      res.json(prefs)
    } catch (err) { next(err) }
  },
)

// ─── Appearance preference (Bloque Y6.1) ───────────────────────────
// Scoped to `me`, same rationale as notification-preferences immediately
// above: a user's own theme is inherently theirs to read/edit — `me`
// removes any IDOR surface structurally, no ownership check needed.
//
// Lazy no-row pattern, identical in shape to NotificationPreference's GET
// above: a user who has never saved a preference has no row yet. GET
// returns the logical defaults (SYSTEM/MEDIUM — see APPEARANCE_PREFERENCE_
// DEFAULTS below, updated Z4) with `updatedAt: null` instead of creating a
// row or 404ing — GET never writes.
//
// PRE-Y8 (Interface Size Preference) — extended to a second, independent
// axis. `interfaceSize` defaulted to ORIGINAL (the exact pre-existing
// baseline) here, mirroring `theme`'s own SYSTEM default exactly in shape.
//
// Z4 — application-level default changed to MEDIUM for a user who has never
// explicitly selected an interface size. This is deliberately NOT the same
// value as the Prisma column's own `@default(ORIGINAL)`
// (schema.prisma's AppearancePreference.interfaceSize) — that DB-level
// default is intentionally left untouched (DEFERRED, pending reconciliation
// of the 20260929120000_add_interface_preset migration's application
// state — see that model's own schema comment, which used to document the
// two defaults as deliberately kept in agreement; for interfaceSize only,
// they now deliberately diverge until that's resolved). `theme` needs no
// equivalent change: SYSTEM still matches the column's own
// `@default(SYSTEM)`.
const APPEARANCE_PREFERENCE_DEFAULTS = {
  theme: 'SYSTEM' as const,
  interfaceSize: 'MEDIUM' as const,
}

// GET /users/me/appearance
router.get('/me/appearance',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const pref = await prisma.appearancePreference.findUnique({
        where:  { userId },
        select: { theme: true, interfaceSize: true, updatedAt: true },
      })
      if (!pref) {
        res.json({
          ...APPEARANCE_PREFERENCE_DEFAULTS,
          updatedAt: null,
        })
        return
      }
      res.json(pref)
    } catch (err) { next(err) }
  },
)

// PATCH /users/me/appearance
// This is the ONE appearance PATCH route/DTO — no separate `/density` or
// `/interface` endpoint. `.strict()` rejects any other key (mass-assignment
// protection).
//
// PRE-Y8 (Interface Size Preference) — BOTH fields are now `.optional()`,
// same explicit-partial-update pattern already used by
// UpdateNotificationPreferencesDto above: a PATCH carrying only one field
// must never reset the other. This is the true-partial-update contract the
// frontend's per-field saveTheme()/saveInterfaceSize() calls rely on (each
// sends a body with exactly one key — see appearanceService.ts) — but the
// route itself accepts either field alone or both together, since nothing
// about the DTO or the upsert below assumes only one is ever sent.
const UpdateAppearancePreferenceDto = z.object({
  theme:         z.enum(['LIGHT', 'DARK', 'SYSTEM']).optional(),
  interfaceSize: z.enum(['ORIGINAL', 'MEDIUM', 'LARGE']).optional(),
}).strict()

router.patch('/me/appearance',
  auth,
  validate(UpdateAppearancePreferenceDto),
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const { theme, interfaceSize } = req.body as {
        theme?: 'LIGHT' | 'DARK' | 'SYSTEM'
        interfaceSize?: 'ORIGINAL' | 'MEDIUM' | 'LARGE'
      }

      // Explicit `!== undefined` (not truthy/`&&`) — same reasoning as
      // UpdateNotificationPreferencesDto's handler above: a field the
      // client did not include in this PATCH at all must be left
      // completely untouched on `update`, never reset to a default. On
      // `create` (first-ever save for this user), an omitted `theme` simply
      // isn't in the payload, so Prisma applies the column's own
      // @default(SYSTEM) — identical to how `create: { userId, theme }`
      // already worked before `interfaceSize` existed, and still correct
      // today since SYSTEM matches APPEARANCE_PREFERENCE_DEFAULTS.theme.
      const data = {
        ...(theme         !== undefined && { theme }),
        ...(interfaceSize !== undefined && { interfaceSize }),
      }

      const pref = await prisma.appearancePreference.upsert({
        where:  { userId },
        update: data,
        // Z4 — `interfaceSize` is the one exception to "let Prisma's own
        // column default apply on create": that column default is still
        // ORIGINAL (deliberately left unchanged — see
        // APPEARANCE_PREFERENCE_DEFAULTS' own Z4 comment above), which no
        // longer matches this app's MEDIUM default. Without this override,
        // a user whose very first-ever Appearance action is a theme-only
        // change (interfaceSize never included in the PATCH) would get a
        // brand-new row carrying interfaceSize: ORIGINAL purely by
        // accident of the raw DB default — never having explicitly chosen
        // it. Explicitly filling it in here on the `create` branch only
        // (never on `update`, so an existing row's real value is still
        // never overwritten by an unrelated PATCH) keeps row-creation
        // consistent with GET's own lazy-default response above, without
        // touching the column default itself.
        create: {
          userId,
          ...data,
          ...(interfaceSize === undefined && { interfaceSize: APPEARANCE_PREFERENCE_DEFAULTS.interfaceSize }),
        },
        select: { theme: true, interfaceSize: true, updatedAt: true },
      })
      res.json(pref)
    } catch (err) { next(err) }
  },
)

// ─── Profile (Bloque Y3) ───────────────────────────────────────────
// Scoped to `me`, same rationale as notification-preferences above: a
// doctor's own profile is inherently theirs to read/edit — no legitimate
// case exists for reading/editing another user's via this route, so `me`
// removes any IDOR surface structurally (no ownership check needed, unlike
// the self-or-admin checks on the /:id routes below, which remain
// unchanged for admin/general use — Settings now uses this route
// exclusively, but /:id is not removed since other callers may still use
// it and no concrete conflict requires touching it).
//
// GET /users/me/profile
router.get('/me/profile',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, email: true, firstName: true, lastName: true, role: true,
          // Z6 — doctor phone added to this same select; returned as `null`
          // for a doctor with none, same nullable convention as the three
          // existing professional fields.
          doctor: { select: { id: true, professionalLicense: true, specialty: true, hospital: true, phone: true } },
          // Y3.1B §19 — metadata ONLY, never `data` (the bytes). This is
          // the one field the avatar retrieval flow needs to know WHEN to
          // (re)fetch the actual image; the image itself only ever comes
          // from the dedicated GET /users/me/avatar route above.
          avatarImage: { select: { updatedAt: true } },
        },
      })
      if (!user) throw new NotFoundError('User')

      // Every MEDICO account gets its Medico row created atomically at
      // registration (see auth.service.ts `register()`), so a MEDICO user
      // with no Medico row is a data-integrity problem, not a normal
      // "nothing filled in yet" state — surfaced explicitly rather than
      // silently answered with fabricated empty professional fields. A
      // non-MEDICO (e.g. ADMIN) genuinely has no Medico row by design, so
      // `doctor` is simply null for them, not an error.
      if (user.role === 'DOCTOR' && !user.doctor) {
        throw new NotFoundError('Medico')
      }

      // `doctor` nested the same way login/register/PATCH /:id already
      // shape it — one consistent User wire-shape regardless of source
      // endpoint (Y3 §14), so the same frontend normalizer works for all
      // of them.
      res.json({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: toPublicRole(user.role),
        medico: toPublicDoctorProfile(user.doctor) ?? null,
        // Y3.1B §19 — the one frozen avatar shape: `{updatedAt}` or `null`.
        avatar: user.avatarImage ? { updatedAt: user.avatarImage.updatedAt } : null,
      })
    } catch (err) { next(err) }
  },
)

// PATCH /users/me/profile
// Strict DTO: firstName/lastName/email/cedulaProfesional/especialidad/
// hospital/phone ONLY. role/id/isActive/userId/passwordHash and any other
// key are rejected by `.strict()` before this handler ever runs — they are
// never silently accepted or updated (mass-assignment protection).
// PRE-R — `email` is new here: previously read-only (Y3 §2/§36), it is now
// editable/clearable for every role, not just MEDICO (User.email exists on
// every account). It reuses NullableCanonicalEmailField (lib/email.ts),
// which already implements the exact PATCH contract this needs: omitted →
// unchanged; null/blank → clear; a non-blank value must be a normalized,
// valid email. Applies uniformly regardless of role — a non-MEDICO (e.g.
// ADMIN) has no Medico.phone at all, so for that account the final-state
// invariant below reduces to "email must stay non-null", which is exactly
// this codebase's pre-existing ADMIN contract (RegisterDto requires email
// for non-MEDICO) — not a new restriction, just now enforced on this route
// too since it can finally change that value.
// Y3-FIX1 — the original Y3 draft added max(50)/max(200) bounds to these
// three fields, reported in the Y3 final report as a transparent engineering
// judgment call rather than a documented rule. Per ChatGPT review, invented
// bounds are not acceptable: this codebase has never bounded these fields.
// Verified by inspecting every pre-Y3 place these fields are validated:
//   - RegisterDto (auth.dto.ts): cedulaProfesional/especialidad/hospital are
//     all bare `z.string().optional()` — no max.
//   - The pre-existing UpdateProfileDto (PATCH /:id, below in this same
//     file): especialidad/hospital are bare `z.string().optional()` — no
//     max (that DTO never accepted cedulaProfesional at all).
//   - schema.prisma: Medico.cedulaProfesional/especialidad/hospital are
//     plain `String?` — no `@db.VarChar(n)`.
// No established limit exists anywhere for these three fields, so none is
// invented here either. firstName/lastName's max(100) is NOT new — it is
// the same bound RegisterDto and UpdateProfileDto already use, reused for
// consistency, not introduced by Y3.
const UpdateMyProfileDto = z.object({
  firstName: z.string().trim().min(1, 'El nombre no puede estar vacío').max(100, 'El nombre es demasiado largo').optional(),
  lastName:  z.string().trim().min(1, 'El apellido no puede estar vacío').max(100, 'El apellido es demasiado largo').optional(),
  // PRE-R — see this DTO's own top-of-block comment. Omitted/null/blank/
  // valid-email semantics come entirely from NullableCanonicalEmailField
  // itself; no additional normalize() needed here, same as `phone` below.
  email: NullableCanonicalEmailField,
  // Nullable (not just optional): this is how the client asks to CLEAR a
  // professional field. `.trim()` here means an already-blank/whitespace
  // string is normalized before the handler ever sees it; the handler
  // additionally treats an empty string the same as null (see `normalize`
  // below), since Zod's `.trim()` cannot itself turn '' into null.
  cedulaProfesional: z.string().trim().nullable().optional(),
  especialidad:      z.string().trim().nullable().optional(),
  hospital:          z.string().trim().nullable().optional(),
  // Z6-FIX1 — doctor phone. NullableCanonicalPhoneField (lib/phone.ts) is
  // ALREADY `.nullable().optional()` with its own blank→null normalization
  // baked in: omitted → unchanged; null OR ""/whitespace → clear; a
  // non-blank value must be a valid canonical E.164 phone. This backend
  // contract holds on its own — it does not rely on the frontend always
  // converting a blank UI state to `null` before it ever reaches here.
  phone:             NullableCanonicalPhoneField,
}).strict()

router.patch('/me/profile',
  auth,
  validate(UpdateMyProfileDto),
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const { firstName, lastName, email, cedulaProfesional, especialidad, hospital, phone } = req.body

      // `!== undefined` (not truthy checks) so a field the client actually
      // sent — including an intentional blank/null to clear it — is
      // distinguished from a field the client simply didn't include in
      // this PATCH at all (left untouched). Mirrors the notification-
      // preferences route's own explicit-provided-vs-omitted pattern.
      const normalize = (v: string | null | undefined) =>
        v === undefined ? undefined : (v === null || v === '' ? null : v)

      const doctorData: Record<string, string | null> = {
        ...(cedulaProfesional !== undefined && { professionalLicense: normalize(cedulaProfesional) }),
        ...(especialidad      !== undefined && { specialty:           normalize(especialidad) }),
        ...(hospital          !== undefined && { hospital:          normalize(hospital) }),
        // Z6-FIX1 — `phone` already arrives as either a valid canonical
        // E.164 string or `null` (NullableCanonicalPhoneField's own
        // preprocess + Zod validation already ran, including its own
        // blank→null normalization); no `normalize()` needed since '' is
        // never a value this field can hold at this point.
        ...(phone             !== undefined && { phone }),
      }

      // PRE-R — this select now also fetches `doctor.phone`: the final-
      // state identity invariant below needs the CURRENT, authoritative
      // phone value (for a PATCH that doesn't touch `phone` at all) exactly
      // as it already needed the current `email` for the same reason.
      // `role` is still "is this even a MEDICO" (a non-MEDICO has no
      // `doctor` relation, hence no phone, ever).
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, email: true, doctor: { select: { phone: true } } },
      })
      if (!current) throw new NotFoundError('User')

      // PRE-R §G — final-state identity invariant, replacing the old Z6-R1/
      // Z6-R1-FIX1 pre-state-only "last phone identifier" check. Now that
      // BOTH email and phone are editable in the same PATCH, the rule must
      // be evaluated against the PROSPECTIVE state after the ENTIRE patch
      // is applied — never the pre-update state in isolation, and never
      // either field checked alone.
      //   prospectiveEmail = email field supplied ? normalized requested
      //                        email : current email
      //   prospectivePhone = (MEDICO only) phone field supplied ?
      //                        normalized requested phone : current phone
      //                        — always null for a non-MEDICO (no Medico
      //                        row, so no fallback identifier ever exists
      //                        for that role; this is the pre-existing
      //                        ADMIN contract, see this DTO's own comment).
      // `email`/`phone` here are already fully normalized by their Zod
      // fields (NullableCanonicalEmailField/NullableCanonicalPhoneField) —
      // `undefined` means "omitted from this PATCH" (leave unchanged),
      // `null` means "explicitly cleared".
      const prospectiveEmail: string | null =
        email !== undefined ? (email as string | null) : current.email
      const prospectivePhone: string | null =
        current.role === 'DOCTOR'
          ? (phone !== undefined ? (phone as string | null) : (current.doctor?.phone ?? null))
          : null

      // Rejected BEFORE any write — no partial mutation, no doctor-profile
      // information Alert. Same "reject before any write" discipline the
      // duplicate-cedula/phone/email P2002 path below already follows.
      if (prospectiveEmail === null && prospectivePhone === null) {
        throw new LastLoginIdentifierError()
      }

      // Atomic: User.firstName/lastName/email and Medico's professional
      // fields are one Profile save. A duplicate-cedula/phone/email
      // conflict must not leave firstName/lastName/email partially
      // committed — the transaction ensures every write succeeds together
      // or none does (PRE-R §I).
      const user = await prisma.$transaction(tx =>
        tx.user.update({
          where: { id: userId },
          data: {
            ...(firstName !== undefined && { firstName }),
            ...(lastName  !== undefined && { lastName }),
            ...(email     !== undefined && { email }),
            ...(current.role === 'DOCTOR' && Object.keys(doctorData).length > 0 && {
              doctor: { update: doctorData },
            }),
          },
          select: {
            id: true, email: true, firstName: true, lastName: true, role: true, updatedAt: true,
            doctor: { select: { id: true, professionalLicense: true, specialty: true, hospital: true, phone: true } },
            // Y3.1B §19 — same metadata-only inclusion as GET /me/profile
            // above; this PATCH never touches the avatar itself (avatar
            // lifecycle is fully independent — Y3.1B §32), it only needs to
            // keep reporting whatever the current avatar metadata already is.
            avatarImage: { select: { updatedAt: true } },
          },
        }),
      )

      // Z6-R2 §1/§2/§4 — the doctor-profile information alert (Z5) is a
      // withdrawn product decision: editing name/last name/cédula/especialidad/
      // hospital/phone must no longer create ANY persisted information
      // Alert, and no replacement is added. This route still returns the
      // updated profile normally — a successful save may still surface the
      // existing Z3 ActionNotification success feedback purely client-side
      // (no backend signal was ever needed for that) — it simply no longer
      // calls AlertService.createInformationAlert at all. No `new_alert`/
      // `alerts_changed` Socket.IO event is emitted for a profile edit.
      res.json({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: toPublicRole(user.role),
        updatedAt: user.updatedAt,
        medico: toPublicDoctorProfile(user.doctor) ?? null,
        avatar: user.avatarImage ? { updatedAt: user.avatarImage.updatedAt } : null,
      })
    } catch (err) {
      // Prisma unique-constraint violation. This write can now reach THREE
      // unique columns — User.email (PRE-R, newly editable here),
      // Medico.cedulaProfesional (pre-existing), and Medico.phone (Z6-R1,
      // since phone doubles as a login identifier) — so `err.meta?.target`
      // must be inspected to tell them apart (same pre-check +
      // P2002-race pattern already used by auth.service.ts::register() for
      // this exact column set; a pre-check alone would miss a race between
      // two concurrent profile updates, so the DB constraint — never
      // weakened — remains the authoritative source of truth here). The
      // current doctor keeping their own unchanged email/cedula/phone never
      // hits this path (no actual write occurs against a differing value),
      // so this only fires for a genuine conflict with another account's
      // row — and never identifies or otherwise leaks which other
      // account/doctor already owns the conflicting value (Z6-R1-FIX1 §5,
      // extended to email by PRE-R §J).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const fields = (err.meta?.target as string[] | undefined) ?? []
        if (fields.includes('email')) {
          next(new DuplicateEmailError())
          return
        }
        if (fields.includes('phone')) {
          next(new DuplicatePhoneError())
          return
        }
        next(new DuplicateCedulaError())
        return
      }
      next(err)
    }
  },
)

// ─── Avatar / profile image (Bloque Y3.1B) ──────────────────────────
// Scoped to `me`, same rationale as every other /me/* route in this file: a
// user's own avatar is inherently theirs to upload/view/remove — `me`
// removes any IDOR surface structurally, identity comes ONLY from
// req.user.sub, never from a body/query/path userId/doctorId/doctorId
// (Y3.1B §8). No admin avatar endpoints exist in this block.
//
// Retrieval is deliberately PRIVATE, never a public/cacheable URL
// (Y3.1A-FIX1's corrected architecture): the frontend cannot render this as
// a plain `<img src="/api/users/me/avatar">` because Y5.2 keeps the access
// token in memory only — a native image request cannot attach the Bearer
// header. The frontend instead fetches this endpoint as an authenticated
// Blob through the same shared `api` Axios instance every other request
// uses (services/avatarService.ts), then renders it via
// `URL.createObjectURL`. This backend route itself is unaware of that — it
// is just an ordinary `authenticate`-gated JSON/binary endpoint, exactly
// like every other route in this file.

// Bounded, in-memory-only upload — never written to disk (Y3.1B §7). The
// 5MB limit here is the FIRST, cheapest rejection point (§11 step 2),
// before any image-decoding library ever touches the bytes. `files: 1`
// enforces the single-file contract structurally, on top of `.single(...)`
// below already only ever populating `req.file` from one field.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

// GET /users/me/avatar — binary image bytes, or 404 NO_AVATAR. Private:
// `Cache-Control: private, no-store` (Y3.1B §18 — no ETag in this first
// implementation, deliberately deferred, see the Y3.1B report). Never
// redirects, never exposes the AvatarImage row's own `id`.
router.get('/me/avatar',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const avatar = await prisma.avatarImage.findUnique({
        where:  { userId },
        select: { data: true, mimeType: true },
      })
      if (!avatar) throw new NoAvatarError()

      res.set('Cache-Control', 'private, no-store')
      res.set('Content-Type', avatar.mimeType)
      res.send(avatar.data)
    } catch (err) { next(err) }
  },
)

// POST /users/me/avatar — required ordering per Y3.1B §9:
// authenticate → avatarUploadLimiter → multipart processing → image
// validation/normalization → DB persistence. Multer's own parsing is
// wrapped so its errors (in particular LIMIT_FILE_SIZE) are mapped onto
// this contract's own stable error codes rather than leaking Multer's raw
// error shape (Y3.1B §15 — "Map Multer file-size errors explicitly to
// 413").
router.post('/me/avatar',
  auth,
  avatarUploadLimiter,
  (req, res: Response, next: NextFunction) => {
    avatarUpload.single('avatar')(req, res, (err: unknown) => {
      if (!err) return next()
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new FileTooLargeError())
      }
      // Any other Multer failure (malformed multipart, wrong field name,
      // more than one file, etc.) — treated as a structurally invalid
      // upload, never as a generic 500 (Y3.1B §7 — "Reject: missing file /
      // multiple avatar files / malformed multipart input").
      next(new InvalidImageError())
    })
  },
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      const file = req.file
      if (!file) throw new InvalidImageError()

      // §11 steps 4-12 — decode, format/animation/dimension validation,
      // orient/crop/resize, bounded quality-ladder WebP encode. Throws one
      // of the frozen avatar error codes on any rejection; nothing below
      // this line runs if it throws, so an existing avatar is left
      // completely untouched by a failed replacement (Y3.1B §16 — "failed
      // decode/process → existing avatar remains unchanged").
      const normalized = await normalizeAvatarUpload(file.buffer, userId)

      // §13 persistence — atomic upsert on the unique userId. The OLD row
      // is never deleted first (Y3.1B §16/§41): a first-time upload creates
      // the row, a replacement updates the SAME row in place in one
      // statement, so there is no window where the user has zero avatar
      // rows. A DB failure here is caught and reported as
      // STORAGE_UNAVAILABLE, distinct from a processing fault — and, same
      // guarantee, never leaves a partially-written row (a single Prisma
      // upsert is one atomic statement).
      let saved: { updatedAt: Date }
      try {
        saved = await prisma.avatarImage.upsert({
          where:  { userId },
          update: { data: normalized.data, mimeType: normalized.mimeType, byteSize: normalized.byteSize },
          create: { userId, data: normalized.data, mimeType: normalized.mimeType, byteSize: normalized.byteSize },
          select: { updatedAt: true },
        })
      } catch (dbErr) {
        throw new AvatarStorageUnavailableError()
      }

      res.json({ avatar: { updatedAt: saved.updatedAt } })
    } catch (err) { next(err) }
  },
)

// DELETE /users/me/avatar — idempotent. `deleteMany` (not `delete`) so a
// caller with no existing avatar still gets a clean 200, never a
// not-found error (Y3.1B §17/§41). Touches nothing else — no User,
// Medico, session, or preference row.
router.delete('/me/avatar',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const userId = (req as AuthRequest).user.sub
      await prisma.avatarImage.deleteMany({ where: { userId } })
      res.json({ avatar: null })
    } catch (err) { next(err) }
  },
)

// ─── Security: real password change (Bloque Y5.1) ──────────────────
// Scoped to `me`, same rationale as notification-preferences/profile above:
// a user's own password is inherently theirs to change — identity comes
// ONLY from req.user.sub (the authenticated access JWT), never from a
// client-supplied userId/id/email/role. No PATCH /users/:id/password exists
// or is added for Settings (Y5.1 §3).
//
// Y5.1 §6 — newPassword reuses RegisterDto's exact password policy
// (Z6-R1 — now imported as the standalone RegisterPasswordField export,
// since RegisterDto itself no longer exposes `.shape`) rather than
// redefining the policy independently: the same rule (min 8, at least one
// uppercase, at least one digit) applies at registration and at password
// change, so this file cannot silently drift from auth.dto.ts.
// currentPassword is deliberately NOT validated against this policy (Y5.1
// §5) — an existing stored credential's validity is determined by
// bcrypt.compare against the stored hash, not by whether it would satisfy
// today's policy (an account may predate a policy change). `.strict()`
// rejects confirmPassword (frontend-only) and any other key (mass-
// assignment protection — Y5.1 §4/§32).
const ChangePasswordDto = z.object({
  currentPassword: z.string().min(1, 'La contraseña actual es requerida'),
  newPassword:     RegisterPasswordField,
}).strict()

// PATCH /users/me/password
router.patch('/me/password',
  auth,
  passwordChangeLimiter,
  validate(ChangePasswordDto),
  async (req, res: Response, next: NextFunction) => {
    try {
      const { sub: userId, sid: currentSid } = (req as AuthRequest).user
      const { currentPassword, newPassword } = req.body

      // Y5.1 §7 — required order: load the credential, verify it, THEN (and
      // only then) consider anything else. Nothing before a successful
      // bcrypt.compare can mutate state.
      const user = await prisma.user.findUnique({
        where:  { id: userId },
        select: { id: true, passwordHash: true },
      })
      if (!user) throw new NotFoundError('User')

      const currentValid = await bcrypt.compare(currentPassword, user.passwordHash)
      if (!currentValid) throw new InvalidCurrentPasswordError()

      // Y5.1 §10 — server-side defense in depth; the frontend already blocks
      // this before the request is sent. Plain string comparison is safe
      // here specifically because currentPassword has JUST been proven to be
      // the user's real password by the bcrypt.compare above.
      if (newPassword === currentPassword) throw new PasswordUnchangedError()

      // Y5.1 §11/§15 — hash BEFORE opening the transaction (bcrypt is
      // deliberately expensive CPU work; it must not hold a DB transaction
      // open). Same cost/configuration as registration — env.BCRYPT_ROUNDS,
      // the only bcrypt cost used anywhere in this codebase (auth.service.ts
      // register()) — never a different/weaker cost invented for this route.
      const rounds = parseInt(env.BCRYPT_ROUNDS, 10)
      const newPasswordHash = await bcrypt.hash(newPassword, rounds)

      // Y8D2c — the CALLER'S session to preserve is the access JWT's own
      // sid (`req.user.sid`), not a fresh refresh-cookie resolution. `auth`
      // has already proven, for this exact request, that this sid names an
      // ACTIVE session belonging to this exact user (verifyAccessToken +
      // assertActiveSession — Y8C-R2 §11/§13), so no second credential is
      // consulted and no additional lookup is needed to trust it.
      //
      // This replaces Y5.2's "resolve via refresh cookie, revoke-all if
      // unresolvable" fallback. That fallback existed only because identity
      // used to depend on a separately re-resolved refresh cookie, which
      // could legitimately fail to resolve (missing/stale cookie) even for
      // an otherwise well-authenticated caller — architecturally wrong for
      // an already-authenticated route once `auth` itself proves an active
      // sid. There is no "cannot determine current session → revoke
      // everything" branch here any more: an authenticated request always
      // has a trusted `req.user.sid`.
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data:  { passwordHash: newPasswordHash },
        }),
        // Y5.1 §12/§15 — still one atomic operation: persist the new hash
        // AND revoke the relevant session rows together. This intentionally
        // does NOT touch the currently active access JWT (§13): it keeps
        // working until its normal expiry, so the user is never forcibly
        // logged out by this operation.
        prisma.refreshToken.deleteMany({ where: { userId, id: { not: currentSid } } }),
      ])

      // Y8D3 §16 — the transaction above already committed (DB-first,
      // Y8D3 §11): only now clean up the now-revoked OTHER sessions' live
      // sockets, never before. If the transaction had thrown, this line is
      // never reached — nothing is disconnected on a failed/rolled-back
      // revoke. The caller's OWN socket (its sessionId === currentSid) is
      // structurally excluded by disconnectOtherSessionSockets, mirroring
      // the DB predicate's `id: { not: currentSid } }` exactly.
      await disconnectOtherSessionSockets(userId, currentSid)

      // Y5.1 §33 — minimal success response. No passwordHash, no tokens, no
      // full User object — nothing beyond what the frontend needs to show
      // success and clear the form.
      res.json({ success: true })
    } catch (err) { next(err) }
  },
)

// ─── Session management (Y5.2) ──────────────────────────────────────
// Backend APIs only — no UI. Listing/revoking a Settings screen for these is
// explicitly Y5.3 scope (Y5.2 §"Explicitly forbidden"), not built here.
// Scoped to `me`, same rationale as every other /me/* route in this file: a
// user's own sessions are inherently theirs to list/revoke — no legitimate
// case for touching another user's, so IDOR protection comes structurally
// from `me` plus an explicit ownership check on the single-session DELETE
// below (which takes an arbitrary :sessionId, unlike the others).

// GET /users/me/sessions — only active (non-expired) sessions; only
// safe fields. Never tokenHash, never any token, access or refresh.
router.get('/me/sessions',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const { sub: userId, sid: currentSid } = (req as AuthRequest).user

      const sessions = await prisma.refreshToken.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
      })

      // Y8D2c — `current` is now derived from the caller's own
      // already-verified access JWT sid (`req.user.sid`), trusted because
      // `auth` has already run verifyAccessToken + assertActiveSession for
      // this exact request (Y8C-R2 §11 "refresh cookie is for refresh
      // only"). Previously this compared against resolveCurrentSession()'s
      // fresh re-resolution of the refresh cookie, which a concurrent
      // refresh rotation could make transiently stale — causing every
      // session in the list to read current:false even though the access
      // JWT already names exactly which session is live. Never a userAgent
      // string match either way — that would be spoofable and imprecise
      // (two sessions can share the same browser/OS string).
      res.json(sessions.map(s => ({
        id: s.id,
        current: s.id === currentSid,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
      })))
    } catch (err) { next(err) }
  },
)

// DELETE /users/me/sessions/others — revokes every session for this user
// EXCEPT the caller's own current one.
//
// Y8D2c — the session to preserve is the access JWT's own sid
// (`req.user.sid`), trusted unconditionally because `auth` has already
// proven, for this exact request, that this sid names an ACTIVE session
// belonging to this exact user (verifyAccessToken + assertActiveSession —
// Y8C-R2 §11/§13). No second credential (the refresh cookie) is consulted,
// and no "cannot resolve current session → revoke everything" fallback
// exists here any more — that ambiguity only ever existed because identity
// depended on a separately re-resolved refresh cookie, which is no longer
// true for this route.
//
// Declared BEFORE the '/:sessionId' route below: Express matches routes in
// registration order, and both are literal 3-segment paths where the third
// segment is either the literal "others" or a param — if ':sessionId' were
// registered first, a DELETE to '.../others' would be captured as
// sessionId === "others" and this handler would never run.
router.delete('/me/sessions/others',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const { sub: userId, sid: currentSid } = (req as AuthRequest).user
      await revokeOtherSessions(userId, currentSid)
      // Y8D3 §15 — DB revoke above already committed; only now disconnect
      // every OTHER live session's sockets for this user, filtering the
      // existing user:${userId} room by each socket's own validated
      // sessionId (never a separately-queried sid list — see the helper's
      // own doc comment in socket/socketServer.ts for why). The caller's
      // own socket (sessionId === currentSid) is excluded, so it stays
      // connected.
      await disconnectOtherSessionSockets(userId, currentSid)
      res.json({ success: true })
    } catch (err) { next(err) }
  },
)

// DELETE /users/me/sessions/:sessionId — revokes one specific session.
// IDOR-safe: a session that doesn't exist and a session owned by a
// different user get the IDENTICAL NotFoundError response — never reveals
// which case occurred. If the revoked session happens to be the caller's
// own current one, the refresh cookie is also cleared and `currentRevoked`
// is reported so the frontend can react (treat this like any other
// session-ending event) instead of silently keeping a now-orphaned cookie.
router.delete('/me/sessions/:sessionId',
  auth,
  async (req, res: Response, next: NextFunction) => {
    try {
      const { sub: userId, sid: currentSid } = (req as AuthRequest).user
      const { sessionId } = req.params

      const session = await prisma.refreshToken.findUnique({ where: { id: sessionId } })
      if (!session || session.userId !== userId) throw new NotFoundError('Session')

      // Y8D2c — "is this the caller's own current session" now compares
      // against the access JWT's own trusted sid (see `auth` above), never
      // against a fresh refresh-cookie resolution. Ownership of the TARGET
      // session (the findUnique + userId check above) is a separate check
      // and is preserved unchanged — this only changes how "current" is
      // determined, not who is allowed to revoke what.
      const currentRevoked = sessionId === currentSid

      await revokeSession(sessionId)
      // Y8D3 §14 — DB revoke above already committed; only now disconnect
      // any live socket(s) for the exact TARGET session (session:${sessionId}
      // — this is correct whether or not the target happens to be the
      // caller's own current session, since the room to target is the same
      // either way). Never disconnected before the DB delete succeeded.
      disconnectSessionSockets(sessionId)
      if (currentRevoked) clearRefreshCookie(res)

      res.json({ success: true, currentRevoked })
    } catch (err) { next(err) }
  },
)

// GET /users/:id
router.get('/:id',
  auth,
  withAuth(async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params
      // Allow self-access or admin
      if (req.user.sub !== id && req.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })
        return
      }
      const user = await prisma.user.findUnique({
        where:  { id },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, isActive: true, createdAt: true,
          doctor: true,
        },
      })
      if (!user) throw new NotFoundError('User')
      res.json({
        ...user,
        role: toPublicRole(user.role),
        medico: toPublicDoctorProfile(user.doctor) ?? null,
        doctor: undefined,
      })
    } catch (err) { next(err) }
  }),
)

// PATCH /users/:id — update own profile
const UpdateProfileDto = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName:  z.string().min(1).max(100).optional(),
  especialidad: z.string().optional(),
  hospital:     z.string().optional(),
})

router.patch('/:id',
  auth,
  validate(UpdateProfileDto),
  withAuth(async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params
      if (req.user.sub !== id && req.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })
        return
      }

      const { firstName, lastName, especialidad, hospital } = req.body

      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(firstName && { firstName }),
          ...(lastName  && { lastName }),
          ...(req.user.role === 'MEDICO' && (especialidad || hospital) && {
            doctor: {
              update: {
                ...(especialidad && { specialty: especialidad }),
                ...(hospital     && { hospital }),
              },
            },
          }),
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, updatedAt: true, doctor: true,
        },
      })
      res.json({
        ...user,
        role: toPublicRole(user.role),
        medico: toPublicDoctorProfile(user.doctor) ?? null,
        doctor: undefined,
      })
    } catch (err) { next(err) }
  }),
)

// DELETE /users/:id — admin only (soft deactivate)
router.delete('/:id',
  auth,
  authorize('ADMIN'),
  async (req, res: Response, next: NextFunction) => {
    try {
      await prisma.user.update({
        where: { id: req.params.id },
        data:  { isActive: false },
      })
      res.json({ success: true })
    } catch (err) { next(err) }
  },
)

export default router
