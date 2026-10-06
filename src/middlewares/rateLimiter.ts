import rateLimit from 'express-rate-limit'
import type { Request } from 'express'
import type { AuthRequest } from '@/types'
import { verifyAccessToken } from '@/lib/jwt'

export const GENERAL_API_WINDOW_MS = 15 * 60 * 1000
export const GENERAL_API_MAX = 2000

// INTEGRITY-1A — the general application limiter is mounted before route-level
// `authenticate`, so req.user is not available here. We intentionally perform
// ONLY cryptographic access-token verification to choose a quota key. This does
// not authorize the request and does not query the session table; canonical
// authorization remains the responsibility of the existing authenticate
// middleware on protected routes.
export function generalApiRateLimitKey(req: Request): string {
  const authHeader = req.headers.authorization

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim()
    if (token) {
      try {
        const payload = verifyAccessToken(token)
        if (payload.sub) return `user:${payload.sub}`
      } catch {
        // Missing/expired/invalid credentials must never bypass the general
        // limiter or turn key selection into a server error. Authorization is
        // evaluated later by the canonical auth middleware.
      }
    }
  }

  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`
}

export const apiLimiter = rateLimit({
  windowMs: GENERAL_API_WINDOW_MS,
  max: GENERAL_API_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: generalApiRateLimitKey,
  message: { error: 'Too many requests, please try again later.', code: 'RATE_LIMITED' },
})

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts.', code: 'RATE_LIMITED' },
})

// Y5.1 — PATCH /users/me/password verifies a credential (bcrypt.compare
// against currentPassword), same category of risk as login, so it gets a
// DEDICATED limiter with the exact same window/max conventions as
// authLimiter above (this file's only other credential-verifying limiter —
// no new rate-limit philosophy invented). A separate instance rather than
// reusing `authLimiter` itself: express-rate-limit buckets by IP within one
// limiter instance, so sharing the same instance would count an
// authenticated user's password-change attempts against the same bucket as
// unauthenticated login/register attempts from that IP — an unrelated
// interaction this block does not intend. This endpoint requires
// `authenticate` first (see user.routes.ts route order), so an
// unauthenticated caller never reaches this limiter at all.
export const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password change attempts.', code: 'RATE_LIMITED' },
})

// Y3.1B — POST /users/me/avatar only (decode + normalize + encode + a
// binary DB write — the one genuinely expensive avatar operation; GET/DELETE
// stay under the ordinary blanket apiLimiter, same as every other
// lightweight /me/* route). The dedicated auth/password limiters above remain
// IP-based because they protect credential-verification surfaces. The general
// apiLimiter now has its own INTEGRITY-1A user-aware keying, but that does not
// change this route's dedicated protection. This route sits behind
// `authenticate` in every mounting (see user.routes.ts route order), so
// `req.user` is always populated by the time this limiter runs, and keying
// by IP here would incorrectly lump every authenticated user behind the same
// NAT/proxy/office IP into one shared bucket. Keyed by `req.user.sub`
// instead, with `req.ip` kept only as a defensive fallback that should never
// actually be reached given the required authenticate → limiter ordering.
export const avatarUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).user?.sub ?? req.ip ?? 'unknown',
  message: { error: 'Too many avatar upload attempts.', code: 'RATE_LIMITED' },
})
