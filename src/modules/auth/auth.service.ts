import bcrypt from 'bcryptjs'
import type { Request, Response } from 'express'
import { Prisma, type Role } from '@prisma/client'
import { prisma } from '@/config/prisma'
import { signAccessToken } from '@/lib/jwt'
import {
  ConflictError,
  UnauthorizedError,
  NotFoundError,
  ServiceUnavailableError,
  RefreshConflictError,
} from '@/lib/errors'
import { logger } from '@/lib/logger'
import { env } from '@/config/env'
import {
  createSession,
  classifyRefreshCredential,
  rotateSession,
  revokeSession,
  clearRefreshCookie,
  hashToken,
} from '@/lib/session'
import { REFRESH_COOKIE_NAME } from '@/lib/cookies'
import { disconnectSessionSockets } from '@/socket/socketServer'
import type { RegisterDtoType, LoginDtoType } from './auth.dto'
import { registrationRoleToDatabase, toPublicDoctorProfile, toPublicRole } from '@/lib/publicIdentity'

export class AuthService {
  // ─── Register ───────────────────────────────────────────────────────
  // Y5.2 — now also opens a stable session (HttpOnly cookie + DB row) the
  // same way login does; the response carries only { user, accessToken } —
  // no refreshToken in JSON (Y5.2 §"no refreshToken in JSON, ever").
  //
  // Z6-R1 §8/§9/§10 — email and phone are both optional at this layer now
  // (RegisterDto's superRefine already guarantees at least one is present
  // for a MEDICO registration before this method ever runs). Pre-checks
  // below are scoped to "if actually provided" — `dto.email`/`dto.phone`
  // are `string | null | undefined` at this point (normalized by the DTO),
  // so a `null`/`undefined` value is never passed into a unique `findUnique`
  // (Prisma's generated where-unique type for a nullable `@unique` column
  // does not accept `null` — a unique index never matches NULL anyway, so
  // there is nothing meaningful to pre-check there regardless). The nested
  // `user.create({ data: { doctor: { create: {...} } } })` below is ONE
  // Prisma write — User and Medico (email and phone together) are
  // persisted atomically; there is no separate second request that could
  // leave one without the other (§9's explicit requirement).
  async register(dto: RegisterDtoType, res: Response, userAgent: string | null) {
    if (dto.email) {
      const existingEmail = await prisma.user.findUnique({ where: { email: dto.email } })
      if (existingEmail) throw new ConflictError('Email already registered')
    }
    if (dto.phone) {
      const existingPhone = await prisma.doctor.findUnique({ where: { phone: dto.phone } })
      if (existingPhone) throw new ConflictError('Phone already registered')
    }

    const rounds = parseInt(env.BCRYPT_ROUNDS, 10)
    const passwordHash = await bcrypt.hash(dto.password, rounds)

    let user
    try {
      user = await prisma.user.create({
        data: {
          // `?? null` — RegisterDto normalizes a blank/omitted email to
          // `null`, so this is already the correct value; the `??` here is
          // purely defensive (TypeScript narrowing, not a behavior change).
          email: dto.email ?? null,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: registrationRoleToDatabase(dto.role),
          ...(dto.role === 'MEDICO' && {
            doctor: {
              create: {
                professionalLicense: dto.cedulaProfesional,
                specialty: dto.especialidad,
                hospital: dto.hospital,
                // Z6-R1 — persisted atomically with the User row created in
                // this same nested write (see method comment above).
                phone: dto.phone ?? null,
              },
            },
          }),
        },
        // Y3.1B §19/§25 — a brand-new registration can never already have an
        // AvatarImage row, but `include`s the relation for shape consistency
        // with login/refresh/me below — sanitizeUser() is the one shared
        // function all four paths funnel through, and it expects this field.
        include: { doctor: true, avatarImage: { select: { updatedAt: true } } },
      })
    } catch (err) {
      // Z6-R1 §10 — defense in depth for the rare race the pre-checks above
      // cannot fully close (two concurrent registrations for the same
      // email/phone). Never exposes Prisma internals — mapped to the exact
      // same ConflictError shape the pre-checks already use.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const fields = (err.meta?.target as string[] | undefined) ?? []
        if (fields.includes('phone')) throw new ConflictError('Phone already registered')
        throw new ConflictError('Email already registered')
      }
      throw err
    }

    // Y8D2 — createSession() runs FIRST (unchanged call, still sets the
    // refresh cookie exactly as before) so its returned sid is in hand
    // before minting the access token, which must now carry that SAME
    // stable session id (Y8C-R2 §5 — never a second, independently-
    // generated id; never derived from the refresh JWT's own jti).
    const sid = await createSession(res, user.id, userAgent)
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: toPublicRole(user.role), sid })

    return { user: this.sanitizeUser(user), accessToken }
  }

  // ─── Login ──────────────────────────────────────────────────────────
  // Z6-R1-FIX1 §1/§3 — `dto.method` is an explicit discriminant the client
  // already knows (LoginPage's own Correo/Teléfono mode toggle) — this
  // method switches on it directly and NEVER re-derives it by inspecting
  // `dto.identifier`'s shape (no leading-'+' check, no '@' check, no
  // regex). Each DTO branch (LoginEmailDto/LoginPhoneDto in auth.dto.ts)
  // already normalized/validated its own identifier (trim+lowercase+email
  // syntax for EMAIL; canonical E.164 for PHONE), so `dto.identifier` is
  // used here exactly as received — no re-trim/re-lowercase/re-validate.
  // Email resolution looks up User directly (email is User's own unique
  // column); phone resolution looks up the owning Medico by its unique
  // phone column and follows it back to the one User that owns it — never
  // a fuzzy/partial match, and Medico.phone's uniqueness (Z6-R1 schema
  // change) guarantees at most one match either way. Both branches
  // converge on the exact same generic-failure/session-creation code
  // below, so a dual-identifier account logs in as the SAME User/session
  // regardless of which identifier it used (§15).
  async login(dto: LoginDtoType, res: Response, userAgent: string | null) {
    const userInclude = { doctor: true, avatarImage: { select: { updatedAt: true as const } } }
    type LoginUser = Prisma.UserGetPayload<{ include: typeof userInclude }>

    let user: LoginUser | null = null

    if (dto.method === 'EMAIL') {
      user = await prisma.user.findUnique({
        where: { email: dto.identifier },
        include: userInclude,
      })
    } else {
      const doctor = await prisma.doctor.findUnique({
        where: { phone: dto.identifier },
        select: { userId: true },
      })
      if (doctor) {
        user = await prisma.user.findUnique({ where: { id: doctor.userId }, include: userInclude })
      }
    }

    // Z6-R1 §13 / Z6-R1-FIX1 §2 — deliberately the SAME generic message/
    // shape regardless of which branch above was taken, and regardless of
    // WHY it failed (identifier didn't resolve to any account vs. password
    // mismatch below, or a malformed/invalid identifier that the DTO layer
    // itself already rejected before this method ever ran) — never reveals
    // "this email exists" / "this phone exists".
    if (!user) throw new UnauthorizedError('Invalid credentials')
    if (!user.isActive) throw new UnauthorizedError('Account disabled')

    const valid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!valid) throw new UnauthorizedError('Invalid credentials')

    // Y8D2 — same reordering/reasoning as register() above.
    const sid = await createSession(res, user.id, userAgent)
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: toPublicRole(user.role), sid })

    return { user: this.sanitizeUser(user), accessToken }
  }

  // ─── Refresh ────────────────────────────────────────────────────────
  // Y5.2 original design, Y8D1 rewrite — no request body. Reads the
  // HttpOnly refresh cookie and classifies it via lib/session.ts's
  // refresh-only classifier (Y8D1) into one of four outcomes:
  //   - VALID_CURRENT   → rotate the session row IN PLACE (same `sid`, new
  //                       credential/hash, never delete+recreate) and
  //                       return a new access token, exactly as before.
  //   - STALE_ROTATED   → this credential names a real session that some
  //                       other request already rotated first (a losing
  //                       concurrent multi-tab refresh) — 409
  //                       REFRESH_CONFLICT, cookie left untouched, no
  //                       credentials issued (Y8D1 §5/§6/§10, Road A).
  //   - TERMINAL_INVALID → the existing, unchanged contract: cookie
  //                       cleared, 401.
  //   - DB_ERROR        → the classification query itself could not be
  //                       answered (infrastructure fault, not a statement
  //                       about credential/session validity) — 503, cookie
  //                       left untouched, no credentials issued (Y8D1 §12).
  // A second, symmetric race (Road B) is handled below: a request can be
  // classified VALID_CURRENT and still lose to a concurrent rotation before
  // its own UPDATE reaches Postgres — rotateSession's compare-and-swap
  // returning `false` gets the SAME REFRESH_CONFLICT treatment as Road A.
  //
  // IMPORTANT — Y8D1 is the backend half of an atomic pair with the
  // not-yet-implemented Y8D4: the current frontend does not understand a
  // 409/REFRESH_CONFLICT response and will treat it as a terminal failure.
  // This method's new conflict behavior is therefore not yet meant to be
  // exercised through the current frontend.
  async refresh(req: Request, res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME]
    if (!raw) throw new UnauthorizedError('No refresh session')

    const classification = await classifyRefreshCredential(req)

    if (classification.status === 'DB_ERROR') {
      // Y8D1 §12/§14 — an operational query failure is never conflated with
      // an invalid credential or a lost race: no cookie is touched, no
      // credentials are issued.
      throw new ServiceUnavailableError('Session refresh')
    }

    if (classification.status === 'TERMINAL_INVALID') {
      clearRefreshCookie(res)
      throw new UnauthorizedError('Refresh session invalid or expired')
    }

    if (classification.status === 'STALE_ROTATED') {
      // Road A — see method-level comment above. Deliberately no
      // clearRefreshCookie() call here (Y8D1 §10): multiple tabs share one
      // cookie jar, and a losing response must never delete a concurrent
      // winner's just-installed credential.
      throw new RefreshConflictError()
    }

    // classification.status === 'VALID_CURRENT' from here on.
    const { sid, userId } = classification

    // Y3.1B §19/§25 — this call previously had NO `include` at all (a plain
    // findUnique), yet still fed the same shared sanitizeUser() below —
    // meaning `refresh()`'s response silently omitted `doctor` too, not just
    // avatar. That gap was left out of scope at the time (a different,
    // unrelated concern that block was not asked to fix), but it is exactly
    // the PRE-R2B-FIX2 auth-rehydration defect: login/register/me all
    // `include: { doctor: true, ... }`, so `especialidad`/`phone`/etc. are
    // present immediately after login, then silently disappear the moment
    // AuthContext's bootstrap effect redeems the refresh cookie through this
    // method on the next page load — the ONE of these four user-data paths
    // that dropped `doctor`. Fixed here by including it the same way the
    // other three already do, so all four paths share one identical User
    // wire-shape (PRE-R2B-FIX2's Canonical Authenticated User Contract).
    let user
    try {
      user = await prisma.user.findUnique({
        where:   { id: userId },
        include: { doctor: true, avatarImage: { select: { updatedAt: true } } },
      })
    } catch (err) {
      // Y8D1 §13 — a thrown exception from the lookup itself (operational
      // fault) is never the same thing as "the referenced user genuinely no
      // longer exists/is inactive" (handled below, unchanged from before
      // this block) — conflating the two would misreport a transient DB
      // outage as a terminal auth failure and clear a perfectly good cookie.
      logger.warn('Refresh: user lookup failed — treating as an infrastructure error, not an invalid session', {
        sid, userId, err: err instanceof Error ? err.message : err,
      })
      throw new ServiceUnavailableError('Session refresh')
    }
    if (!user || !user.isActive) {
      clearRefreshCookie(res)
      throw new UnauthorizedError('User not found or inactive')
    }

    // classifyRefreshCredential already confirmed `raw`'s hash matches the
    // row's CURRENT tokenHash at the moment it read the row — recompute it
    // here as the compare-and-swap's expected "old" value. Any change to
    // the row between that read and this UPDATE (i.e. a concurrent refresh
    // that rotated first) is exactly the race rotateSession's CAS is built
    // to detect — see lib/session.ts for the full explanation.
    let rotated: boolean
    try {
      rotated = await rotateSession(res, sid, userId, hashToken(raw))
    } catch (err) {
      // Y8D1 §14 — a THROWN exception from the rotate UPDATE (infrastructure
      // fault) is never the same thing as the CAS returning `count === 0`
      // just below (Road B) — the former must never become a 409, and the
      // latter must never become a 503.
      logger.warn('Refresh: session rotation failed — treating as an infrastructure error, not a conflict', {
        sid, userId, err: err instanceof Error ? err.message : err,
      })
      throw new ServiceUnavailableError('Session refresh')
    }
    if (!rotated) {
      // Road B — see method-level comment above. Same external contract as
      // Road A: 409 REFRESH_CONFLICT, no cookie clear, no credentials
      // (Y8D1 §6/§10).
      throw new RefreshConflictError()
    }

    // Y8D2 — `sid` is the same stable id this row has always had
    // (rotateSession updates the row in place, never changing its id), so
    // the newly-minted access token names exactly the session that was
    // just rotated.
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: toPublicRole(user.role), sid })
    return { user: this.sanitizeUser(user), accessToken }
  }

  // ─── Logout ─────────────────────────────────────────────────────────
  // Y8D2b full rewrite — identity now comes from the CALLER (the already-
  // verified access JWT's own `sid`, resolved by authenticateForLogout +
  // the controller), never re-derived from the refresh cookie. This closes
  // Y8C-R2's Gap B: a one-generation-stale refresh cookie can no longer
  // cause `resolveCurrentSession()` to return null and silently skip the
  // DB revoke while still appearing to "log out" client-side — the refresh
  // credential has zero authority over which session gets revoked here
  // (Y8C-R2 §11, "refresh cookie is for refresh only").
  //
  // revokeSession()'s `deleteMany` is naturally idempotent (zero matched
  // rows just returns `{count: 0}`, never throws) — an already-revoked or
  // otherwise-absent sid is a safe no-op, not an error. The refresh cookie
  // is cleared in `finally` unconditionally: a thrown DB error must still
  // leave the browser's cookie cleared (so the client-side "log me out"
  // half of this operation always completes), while the error itself is
  // still propagated up (never swallowed into a fake success) so it can be
  // surfaced as a 5xx by the generic AppError handler — never misreported
  // as a 401/expired-session (same DB-outage-vs-invalid-session distinction
  // Y8D2's assertActiveSession already draws for the read path).
  async logout(sid: string, res: Response): Promise<void> {
    try {
      await revokeSession(sid)
      // Y8D3 §13 — the authoritative DB revoke above succeeded FIRST; only
      // now is any live Socket.IO connection for this exact sid terminated
      // (session:${sid} — every same-browser tab sharing this session's
      // refresh cookie disconnects together, Y8D3 §19). Placed inside the
      // `try`, after the awaited revoke and before the `catch`, so a
      // thrown revoke error skips this line entirely — sockets are never
      // disconnected on the strength of a revoke that did not actually
      // succeed (Y8D3 §13's explicit requirement). disconnectSessionSockets
      // itself never throws (best-effort, internally caught/logged in
      // socket/socketServer.ts), so it cannot turn a successful revoke into
      // a reported logout failure.
      disconnectSessionSockets(sid)
    } catch (err) {
      logger.warn('Logout: authoritative session revoke failed — local cookie still cleared, error still reported', {
        sid,
        err: err instanceof Error ? err.message : err,
      })
      throw new ServiceUnavailableError('Session revocation')
    } finally {
      clearRefreshCookie(res)
    }
  }

  // ─── Me ─────────────────────────────────────────────────────────────
  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { doctor: true, avatarImage: { select: { updatedAt: true } } },
    })
    if (!user) throw new NotFoundError('User')
    return this.sanitizeUser(user)
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  // Y3.1B §19/§23 — `avatarImage` added to the accepted shape and to the
  // returned `avatar` field, following the exact same "select `updatedAt`
  // only, never `data`" discipline every other metadata path in this block
  // uses (Y3.1B §19/§42 — the bytes are read exclusively inside the
  // dedicated GET /users/me/avatar route, never through this function).
  private sanitizeUser(user: {
    // Z6-R1 — nullable: a phone-only doctor has no email at all.
    id: string; email: string | null; firstName: string; lastName: string; role: Role; isActive: boolean; createdAt: Date
    // PRE-R2B-FIX2 — widened to the full Medico shape (this already was what
    // register()/login()/me() passed through at runtime via their own
    // `include: { doctor: true }`; only this declared parameter type under-
    // stated it as especialidad/hospital-only). Now that refresh() includes
    // `doctor` too, this type accurately reflects every caller.
    doctor?: { id: string; professionalLicense: string | null; specialty: string | null; hospital: string | null; phone: string | null } | null
    avatarImage?: { updatedAt: Date } | null
  }) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: toPublicRole(user.role),
      isActive: user.isActive,
      createdAt: user.createdAt,
      medico: toPublicDoctorProfile(user.doctor),
      avatar: user.avatarImage ? { updatedAt: user.avatarImage.updatedAt } : null,
    }
  }
}
