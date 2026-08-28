import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import { verifyAccessToken } from '@/lib/jwt'
import { UnauthorizedError } from '@/lib/errors'

export function authenticate(req: AuthRequest, _res: Response, next: NextFunction): void {
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
