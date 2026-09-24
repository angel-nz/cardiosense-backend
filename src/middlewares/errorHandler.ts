import type { Request, Response, NextFunction } from 'express'
import { AppError, ModelIneligibleError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { Prisma } from '@prisma/client'

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // U8.6C — checked BEFORE the generic AppError branch (ModelIneligibleError
  // extends AppError, so it would otherwise match that branch first and
  // lose its extra fields). The frontend needs modelVersion/eligibleAgeRange
  // to build its message dynamically — the range must never be hardcoded
  // client-side. These are the only two fields added; no other AppError
  // subtype exposes extra data through this handler.
  if (err instanceof ModelIneligibleError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      modelVersion: err.modelVersion,
      eligibleAgeRange: err.eligibleAgeRange,
    })
    return
  }

  // Known application errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    })
    return
  }

  // Prisma unique constraint violation
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const fields = (err.meta?.target as string[])?.join(', ')
      res.status(409).json({
        error: `Duplicate value for: ${fields}`,
        code: 'CONFLICT',
      })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' })
      return
    }
  }

  // Unknown errors
  logger.error('Unhandled error', { message: err.message, stack: err.stack })
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  })
}
