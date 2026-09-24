import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { AuthRequest } from '@/types'
import { verifyAccessToken } from '@/lib/jwt'
import { UnauthorizedError } from '@/lib/errors'

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
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
