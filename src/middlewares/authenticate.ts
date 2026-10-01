import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { AuthRequest } from '@/types'
import { verifyAccessToken } from '@/lib/jwt'
import { assertActiveSession } from '@/lib/session'
import { UnauthorizedError, ServiceUnavailableError } from '@/lib/errors'

// Y8D2 — cryptographic verification (verifyAccessToken) alone no longer
// suffices: a signature-valid, unexpired access JWT can still name a
// session that has since been revoked or expired at the DB level (F4).
// Order is deliberate and unchanged from before this block: verify the
// JWT's signature/expiry FIRST (cheap, no DB access) — a malformed or
// expired token is rejected immediately, with no session lookup ever
// attempted for it. Only a structurally valid token proceeds to the
// canonical active-session check (lib/session.ts::assertActiveSession),
// the same helper Socket.IO's handshake will reuse in a later block
// (Y8D3) — this rule is never duplicated a second time here.
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('No token provided'))
  }

  const token = authHeader.split(' ')[1]
  let payload
  try {
    payload = verifyAccessToken(token)
  } catch (err) {
    return next(err)
  }

  const status = await assertActiveSession(payload.sid, payload.sub)
  if (status === 'DB_ERROR') {
    // Never misreport an infrastructure failure as a revoked/invalid
    // credential — a transient DB outage must not force a client-side
    // logout (Y8C-R1 §15, Y8C-R2 §9). Reusing ServiceUnavailableError as-is
    // (already the codebase's established 503 shape, e.g. the AI service)
    // rather than adding a new error class for this one call site.
    return next(new ServiceUnavailableError('Session validation'))
  }
  if (status === 'INACTIVE') {
    return next(new UnauthorizedError('Session no longer active'))
  }

  req.user = payload
  next()
}

// Y8D2b — logout-ONLY identity check. Deliberately NOT the ordinary
// `authenticate` above: logout's whole job is to terminate the session
// named by its own signed access JWT, not to read or mutate protected
// data, so it must not require that session to still be ACTIVE in the DB
// first — an already-revoked session, or one hit by a transient DB outage
// during the active-session check, must still let the browser reach the
// handler and clear its local state/refresh cookie (Y8C-R2 §4/§12; this
// block's own §4). This performs ONLY Bearer presence + verifyAccessToken()
// (signature/expiry) — the same crypto check `authenticate` does before its
// own DB lookup — and deliberately never calls assertActiveSession().
//
// Do NOT reuse this for any other route. Every route that reads or mutates
// protected data must keep using the ordinary `authenticate` above, which
// still enforces the active-session check in full — this helper exists
// solely because logout's own product contract (terminate my session,
// unconditionally) is different from every other authenticated route's.
export function authenticateForLogout(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('No token provided'))
  }

  const token = authHeader.split(' ')[1]
  try {
    req.user = verifyAccessToken(token)
    next()
  } catch (err) {
    next(err)
  }
}

function isAuthenticated(req: Request): req is AuthRequest {
  return req.user !== undefined
}

// Exposes an authenticated handler as a normal Express RequestHandler. The
// runtime guard narrows Request -> AuthRequest (no cast); it can only fail if
// the handler was mounted without `authenticate`, and then yields a clean 401.
export function withAuth(
  handler: (req: AuthRequest, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    if (!isAuthenticated(req)) return next(new UnauthorizedError('Not authenticated'))
    handler(req, res, next)
  }
}
