import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '@/types'
import { ForbiddenError } from '@/lib/errors'

export function authorize(...roles: string[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new ForbiddenError('Not authenticated'))
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new ForbiddenError('Insufficient permissions'))
    }
    next()
  }
}
