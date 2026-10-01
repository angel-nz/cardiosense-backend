import jwt from 'jsonwebtoken'
import { env } from '@/config/env'
import { UnauthorizedError } from './errors'

// Y8D2 — `sid` added: the SAME stable session id already carried by the
// refresh JWT (RefreshToken.id, unchanged across rotation — see
// RefreshJwtPayload below and lib/session.ts). Mandatory, not optional:
// every access-token mint site (auth.service.ts's register/login/refresh)
// now supplies it, so an access JWT that somehow lacked it would be a
// construction bug, not a legitimate variant — see authenticate.ts, which
// uses it to look up the session's live/revoked state (F4). This does NOT
// change what the token cryptographically proves about IDENTITY (sub/email/
// role are unchanged); it adds which SESSION the token belongs to, so that
// identity can be checked against a still-active RefreshToken row on every
// request, not just verified as never having been tampered with.
export interface JwtPayload {
  sub: string      // userId
  // Z6-R1 — nullable: a phone-only doctor has no email at all. Note this
  // claim is never actually READ back out anywhere (grep-confirmed across
  // the backend) — every identity/authorization decision keys off `sub`/
  // `sid` instead (middlewares/authenticate.ts, socket auth). It is kept
  // here only because every access-token mint site already supplies it and
  // removing the field entirely would be an unrelated, unasked-for JWT
  // shape change; it is never promoted to a synthetic non-null value to
  // "compensate" for a missing email.
  email: string | null
  role: string
  sid: string      // stable session id (== RefreshToken.id)
  iat?: number
  exp?: number
}

// Y5.2 — the refresh credential is still a signed JWT (the block's preferred
// approach — no justification arose to switch to an opaque token), now
// carrying two additional claims:
//   sid — the STABLE session id (== RefreshToken.id). Constant across every
//         rotation of this session; this is what lets refresh/logout/session
//         listing/revocation and the Y5.1 password-change "preserve current
//         session" logic all refer to "this session" as one identity.
//   jti — a fresh random id minted on EVERY rotation (including the very
//         first mint at session creation). Its only purpose is to make two
//         consecutive tokens for the same sid syntactically distinct even if
//         issued in the same second (iat alone would not guarantee that);
//         nothing currently reads jti back out — the actual replay/rotation
//         safety comes from the tokenHash compare-and-swap in lib/session.ts,
//         not from jti uniqueness enforcement.
export interface RefreshJwtPayload {
  sub: string      // userId
  sid: string      // stable session id
  jti: string      // per-rotation uniqueness
  iat?: number
  exp?: number
}

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
}

export function signRefreshToken(payload: { sub: string; sid: string; jti: string }): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
}

export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token expired')
    }
    throw new UnauthorizedError('Invalid token')
  }
}

export function verifyRefreshToken(token: string): RefreshJwtPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshJwtPayload
  } catch {
    throw new UnauthorizedError('Invalid refresh token')
  }
}

// Y5.2 — derives the DB row's `expiresAt` from the credential's OWN real
// expiry (its signed `exp` claim), replacing the old storeRefreshToken's
// hardcoded `setDate(+7)`, which drifted from JWT_REFRESH_EXPIRES_IN the
// moment that env var was ever changed from its default. Decoding (not
// re-verifying) is intentional and safe here: this is only ever called
// immediately after this same process signed the token a line earlier, on a
// value that has not left the server yet — there is no untrusted input to
// authenticate at this point, only a value to read back.
export function decodeTokenExpiry(token: string): Date {
  const decoded = jwt.decode(token) as { exp?: number } | null
  if (!decoded?.exp) {
    throw new Error('Signed refresh token is missing an exp claim')
  }
  return new Date(decoded.exp * 1000)
}
