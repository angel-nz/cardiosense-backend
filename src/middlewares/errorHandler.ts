import type { Request, Response, NextFunction } from 'express'
import { AppError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { Prisma } from '@prisma/client'

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
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
