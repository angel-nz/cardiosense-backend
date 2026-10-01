import rateLimit from 'express-rate-limit'
import type { AuthRequest } from '@/types'

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
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
// lightweight /me/* route). Verified this block: none of the three limiters
// above define their own `keyGenerator`, so they all fall back to
// express-rate-limit v7's default — IP-based — keying; that is fine for
// login/register/password-change, which must also throttle an UNauthenticated
// or not-yet-verified caller by IP. This route is different: it sits behind
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
