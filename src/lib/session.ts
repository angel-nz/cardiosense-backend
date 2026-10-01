import { randomUUID, createHash } from 'crypto'
import type { Request, Response } from 'express'
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'
import { signRefreshToken, verifyRefreshToken, decodeTokenExpiry } from '@/lib/jwt'
import { setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE_NAME } from '@/lib/cookies'

// Y5.2 — the stable-session refresh architecture. This is the ONE module
// that creates, resolves, rotates, and revokes a session row, so every
// caller (auth.service.ts's login/register/refresh/logout, the
// GET/DELETE /users/me/sessions* routes, and the Y5.2-adapted Y5.1
// password-change route) shares exactly one implementation of "what a
// session is" and "how the refresh cookie is read" — never duplicated
// cookie/session-parsing logic across modules (Y5.2 §"one reusable current
// session resolution helper").
//
// A session's `id` (== the refresh JWT's `sid` claim) is stable across
// rotation — POST /auth/refresh always UPDATEs the same row in place, never
// deletes + recreates it (Y5.2 §13). Only a SHA-256 hash of the raw refresh
// credential is ever persisted (`tokenHash`); the raw value exists only
// transiently in process memory, long enough to set the cookie, and is never
// logged.

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ─── Create ─────────────────────────────────────────────────────────────
// Used by login/register only — always mints a brand-new session row.
export async function createSession(
  res: Response,
  userId: string,
  userAgent: string | null,
): Promise<string> {
  const sid = randomUUID()
  const jti = randomUUID()
  const refreshToken = signRefreshToken({ sub: userId, sid, jti })
  const expiresAt = decodeTokenExpiry(refreshToken)
  const tokenHash = hashToken(refreshToken)

  await prisma.refreshToken.create({
    data: { id: sid, userId, tokenHash, userAgent, expiresAt, lastUsedAt: new Date() },
  })

  setRefreshCookie(res, refreshToken, expiresAt)
  return sid
}

// ─── Resolve ────────────────────────────────────────────────────────────
export interface CurrentSession {
  sid: string
  userId: string
}

// The single place that reads and validates the refresh cookie against the
// DB. Returns null on ANY failure (missing cookie, malformed/expired JWT,
// no matching row, row belongs to a different user than the JWT claims,
// row expired, or the presented credential's hash no longer matches the
// stored one) — deliberately without distinguishing which case occurred to
// the caller's response, so a caller can never be used to probe whether a
// given sid exists (Y5.2 §"never leak whether a given sid exists").
export async function resolveCurrentSession(req: Request): Promise<CurrentSession | null> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME]
  if (!raw) return null

  let payload
  try {
    payload = verifyRefreshToken(raw)
  } catch {
    return null
  }

  const stored = await prisma.refreshToken.findUnique({ where: { id: payload.sid } })
  if (!stored) return null
  if (stored.userId !== payload.sub) return null
  if (stored.expiresAt < new Date()) return null
  if (hashToken(raw) !== stored.tokenHash) return null

  return { sid: stored.id, userId: stored.userId }
}

// ─── Refresh classification (Y8D1) ─────────────────────────────────────
// POST /auth/refresh needs a finer-grained answer than resolveCurrentSession()
// above deliberately gives: it must tell apart a credential that names a
// real, still-valid session but was already superseded by a rotation that
// beat this request to it ("STALE_ROTATED" — the multi-tab refresh-race
// case, which must produce a 409 REFRESH_CONFLICT, never a 401) from a
// credential/session that is genuinely dead ("TERMINAL_INVALID" — the
// existing 401 + clear-cookie contract, unchanged) from an operational
// failure to even query the database ("DB_ERROR" — never reported as
// either of the above, see assertActiveSession's identical reasoning
// below, whose try/catch/DB_ERROR shape this deliberately mirrors rather
// than re-implementing differently).
//
// This is a SEPARATE function from resolveCurrentSession(), not a
// reimplementation of it: resolveCurrentSession() deliberately collapses
// every failure mode into a single `null` (Y5.2 §"never leak whether a
// given sid exists") because its own remaining callers need nothing finer
// than "valid or not" — widening its return type would be a behavior
// change for those callers for no benefit to them. resolveCurrentSession()
// is left exactly as-is (Y8D1 §16).
//
// Scope is deliberately narrow: this exists ONLY for POST /auth/refresh's
// own response contract (Y8D1 §17) — it is not a general "does this stale
// sid still exist" check and must never be reused by another route.
export type RefreshClassification =
  | { status: 'VALID_CURRENT'; sid: string; userId: string }
  | { status: 'STALE_ROTATED' }
  | { status: 'TERMINAL_INVALID' }
  | { status: 'DB_ERROR' }

export async function classifyRefreshCredential(req: Request): Promise<RefreshClassification> {
  const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME]
  if (!raw) return { status: 'TERMINAL_INVALID' }

  let payload
  try {
    payload = verifyRefreshToken(raw)
  } catch {
    return { status: 'TERMINAL_INVALID' }
  }

  let stored
  try {
    stored = await prisma.refreshToken.findUnique({ where: { id: payload.sid } })
  } catch (err) {
    logger.warn('Refresh classification failed — treating as an infrastructure error, not an invalid credential', {
      sid: payload.sid,
      err: err instanceof Error ? err.message : err,
    })
    return { status: 'DB_ERROR' }
  }

  if (!stored) return { status: 'TERMINAL_INVALID' }
  if (stored.userId !== payload.sub) return { status: 'TERMINAL_INVALID' }
  // Same boundary convention as the expiry check below (strict `<` — an
  // expired-but-not-yet-cleaned-up row is invalid).
  if (stored.expiresAt < new Date()) return { status: 'TERMINAL_INVALID' }

  // The one check resolveCurrentSession() collapses into `null` alongside
  // everything else above — here it is the sole thing that distinguishes
  // STALE_ROTATED from VALID_CURRENT (Y8D1 §4/§6, Road A).
  if (hashToken(raw) !== stored.tokenHash) return { status: 'STALE_ROTATED' }

  return { status: 'VALID_CURRENT', sid: stored.id, userId: stored.userId }
}

// ─── Active-session check (Y8D2) ───────────────────────────────────────
// The ONE canonical rule for "does this sid, already carried by an
// otherwise-cryptographically-valid access JWT, still name a live session"
// — used by HTTP's authenticate middleware today and, per the accepted Y8C
// architecture, reused as-is by Socket.IO's handshake in a later block
// (Y8D3), so this rule is never re-implemented a second time anywhere else.
//
// Deliberately NOT the same check as resolveCurrentSession() above:
// resolveCurrentSession() authenticates a raw refresh COOKIE from scratch
// (JWT signature + row + user + expiry + tokenHash match) because the
// refresh credential's whole job is proving authority to mint a new access
// token. This function instead takes a sid that has ALREADY been read out
// of an access JWT whose signature and expiry the caller has already
// verified — it only asks "is the session that sid names still alive,"
// which never requires (and must never check) tokenHash: hash/rotation is a
// refresh-credential concern, not an ordinary-request authorization one
// (Y8C-R2 §6). It also never touches `lastUsedAt` — that column reflects
// actual login/refresh activity, not every authenticated API call.
//
// A 3-way result (never a boolean) is required so callers can fail CLOSED
// on a genuinely dead/foreign session (safe to answer with a 401) while
// never confusing that with an infrastructure failure (the query itself
// throwing) — conflating the two would misreport a transient DB outage as
// "your session was revoked" and force an incorrect client-side logout
// (Y8C-R1 §15/§9, Y8C-R2 §15).
export type ActiveSessionCheck = 'ACTIVE' | 'INACTIVE' | 'DB_ERROR'

export async function assertActiveSession(
  sid: string | undefined,
  userId: string,
): Promise<ActiveSessionCheck> {
  if (!sid) return 'INACTIVE'

  let row: { userId: string; expiresAt: Date } | null
  try {
    row = await prisma.refreshToken.findUnique({
      where:  { id: sid },
      select: { userId: true, expiresAt: true },
    })
  } catch (err) {
    logger.warn('Active-session check failed — treating as an infrastructure error, not a revoked session', {
      sid,
      userId,
      err: err instanceof Error ? err.message : err,
    })
    return 'DB_ERROR'
  }

  if (!row) return 'INACTIVE'
  if (row.userId !== userId) return 'INACTIVE'
  // Same boundary convention as resolveCurrentSession's own expiry check
  // above (strict `<` — an expired-but-not-yet-cleaned-up row is invalid).
  if (row.expiresAt < new Date()) return 'INACTIVE'

  return 'ACTIVE'
}

// ─── Rotate ─────────────────────────────────────────────────────────────
// Rotates an existing session IN PLACE (same row/`sid`): new credential
// signed, new hash stored, `lastUsedAt`/`expiresAt` bumped — never
// delete+recreate (Y5.2 §13).
//
// Implemented as a compare-and-swap: the UPDATE's WHERE clause requires the
// row's CURRENT tokenHash to still equal the hash of the credential the
// caller actually presented (`oldTokenHash`, computed by the caller from the
// raw cookie it read). If two refresh requests race with the same
// now-shared old credential (e.g. a duplicated network retry, or two browser
// tabs that both read the cookie before either rotated it), only the first
// UPDATE to reach Postgres matches a row (`count === 1`) — the second
// matches zero rows because the first already changed `token_hash` out from
// under it, and its `count === 0` tells the caller to treat that request as
// invalid/replayed rather than silently overwriting the rotation that just
// happened. This is real optimistic-concurrency protection against that
// specific race (verified against a live Postgres instance — see the Y5.2
// report); it does NOT make concurrent multi-tab refresh transparent to the
// user — the losing tab's request genuinely fails and must re-authenticate
// via its own next 401 → refresh cycle (or, if its cookie was already
// clobbered by the winner, via a full login). That is reported here plainly,
// not smoothed over.
export async function rotateSession(
  res: Response,
  sid: string,
  userId: string,
  oldTokenHash: string,
): Promise<boolean> {
  const jti = randomUUID()
  const refreshToken = signRefreshToken({ sub: userId, sid, jti })
  const expiresAt = decodeTokenExpiry(refreshToken)
  const newTokenHash = hashToken(refreshToken)

  const result = await prisma.refreshToken.updateMany({
    where: { id: sid, tokenHash: oldTokenHash },
    data: { tokenHash: newTokenHash, expiresAt, lastUsedAt: new Date() },
  })

  if (result.count === 0) return false

  setRefreshCookie(res, refreshToken, expiresAt)
  return true
}

// Exposed for auth.service.ts's refresh() flow, which needs to hash the raw
// cookie value itself to pass as `oldTokenHash` above.
export { hashToken }

// ─── Revoke ─────────────────────────────────────────────────────────────
export async function revokeSession(sid: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { id: sid } })
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } })
}

export async function revokeOtherSessions(userId: string, keepSid: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId, id: { not: keepSid } } })
}

// Re-exported so callers that only need to clear the cookie (without the
// rest of lib/cookies.ts) can import everything session-related from here.
export { clearRefreshCookie }
