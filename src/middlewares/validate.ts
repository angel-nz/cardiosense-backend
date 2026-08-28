import type { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError } from 'zod'

type Target = 'body' | 'query' | 'params'

export function validate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target])
    if (!result.success) {
      const errors: Record<string, string> = {}
      result.error.errors.forEach(e => {
        const key = e.path.join('.')
        errors[key] = e.message
      })
      res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: errors,
      })
      return
    }
    req[target] = result.data
    next()
  }
}
