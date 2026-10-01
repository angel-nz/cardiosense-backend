import type { Request, Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import { AuthService } from './auth.service'

const svc = new AuthService()

// Y5.2 — raw request-header string only, captured once at session creation
// (register/login). Never parsed into a browser/OS/device breakdown, never
// combined with an IP or any geolocation source — exactly the same
// `userAgent: string | null` shape lib/session.ts persists as-is.
function getUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent']
  return typeof ua === 'string' ? ua : null
}

export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.register(req.body, res, getUserAgent(req))
    res.status(201).json(result)
  } catch (err) { next(err) }
}

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.login(req.body, res, getUserAgent(req))
    res.json(result)
  } catch (err) { next(err) }
}

// Y5.2 — no request body: the refresh credential travels only as the
// `cardiosense_refresh` HttpOnly cookie, read inside svc.refresh().
export const refresh = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.refresh(req, res)
    res.json(result)
  } catch (err) { next(err) }
}

// Y8D2b — no request body: the session to revoke is identified from the
// caller's OWN already-verified access JWT (`req.user.sid`, set by the
// route's `authenticateForLogout` middleware), never from the refresh
// cookie (Y8C-R2 Gap B). `req` is typed `AuthRequest` here because this
// route's middleware chain (authenticateForLogout, then withAuth) already
// guarantees `req.user` is populated before this handler ever runs — the
// same guarantee every other `withAuth`-wrapped handler in this file
// relies on. A DB-outage revoke failure propagates as a thrown
// ServiceUnavailableError (surfaced as 503 by the generic error handler)
// rather than a false-success — logout is idempotent for an
// already-revoked/absent session, but never for a genuine infrastructure
// failure.
export const logout = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await svc.logout(req.user.sid, res)
    res.json({ success: true })
  } catch (err) { next(err) }
}

export const me = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await svc.me(req.user.sub)
    res.json(user)
  } catch (err) { next(err) }
}
