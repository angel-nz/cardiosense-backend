import type { Response, CookieOptions } from 'express'
import { env } from '@/config/env'

// Y5.2 — the ONE place the refresh-cookie contract is defined. Every caller
// that sets or clears this cookie (login/register/refresh in auth.service.ts,
// logout, the session-revocation routes in user.routes.ts) goes through
// setRefreshCookie/clearRefreshCookie below — never `res.cookie(...)`
// directly — so the name/path/httpOnly/secure/sameSite attributes can never
// drift between a `set` and a later `clear`. A mismatch there is a classic
// way to leave a cookie the browser silently refuses to remove (clearCookie
// must be called with the SAME attributes used to set it, minus the
// value/maxAge/expires themselves).
export const REFRESH_COOKIE_NAME = 'cardiosense_refresh'

// Scoped to /api (not just /api/auth): the cookie must also reach the
// session-management endpoints (GET/DELETE /api/users/me/sessions...) and
// PATCH /api/users/me/password (Y5.2's adapted Y5.1 route), which all
// resolve "the caller's current session" the same way refresh/logout do
// (lib/session.ts resolveCurrentSession). A narrower /api/auth path would
// silently not reach those.
const COOKIE_PATH = '/api'

function baseCookieOptions(): CookieOptions {
  const isProd = env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    // Secure only in production (this dev/CI environment serves the API
    // over plain HTTP; a Secure cookie would never be sent back at all in
    // that case). Always true once deployed behind HTTPS.
    secure: isProd,
    // Lax is sufficient for this app's actual traffic pattern: the frontend
    // always calls the API directly (XHR/fetch), never via a cross-site
    // top-level navigation that would need the cookie attached, and
    // frontend+backend are same-site in every environment this app ships to
    // (they differ only by port in local dev, which SameSite still treats as
    // the same site). `SameSite=None` is deliberately never used anywhere in
    // this codebase — this app has no legitimate cross-site refresh flow —
    // so it is not wired up as an option here. If a future deployment ever
    // genuinely splits the frontend and backend across different sites,
    // switching to `None` would ALSO require `Secure:true` (already the case
    // in production) AND an explicit Origin/CSRF check on the refresh/logout
    // routes — CORS configuration alone does not provide CSRF protection for
    // a cookie-carried credential, and that check does not exist today.
    sameSite: 'lax',
    path: COOKIE_PATH,
  }
}

// `expiresAt` is the refresh JWT's OWN real expiry (see
// lib/jwt.ts::decodeTokenExpiry) — the cookie's maxAge is derived from it so
// the two can never drift apart, replacing the old independent "+7 days"
// hardcode this block removes.
export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now())
  res.cookie(REFRESH_COOKIE_NAME, token, { ...baseCookieOptions(), maxAge })
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions())
}
