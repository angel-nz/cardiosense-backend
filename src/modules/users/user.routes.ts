import { Router } from 'express'
import type { RequestHandler, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticate } from '@/middlewares/authenticate'
import { authorize } from '@/middlewares/authorize'
import { validate } from '@/middlewares/validate'
import { prisma } from '@/config/prisma'
import { NotFoundError } from '@/lib/errors'
import type { AuthRequest } from '@/types'

const router = Router()
const auth   = authenticate as RequestHandler

// GET /users — admin only
router.get('/',
  auth,
  authorize('ADMIN') as RequestHandler,
  async (_req, res: Response, next: NextFunction) => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, isActive: true, createdAt: true,
          medico: { select: { especialidad: true, hospital: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
      res.json(users)
    } catch (err) { next(err) }
  },
)

// GET /users/:id
router.get('/:id',
  auth,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params
      // Allow self-access or admin
      if (req.user.sub !== id && req.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })
        return
      }
      const user = await prisma.user.findUnique({
        where:  { id },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, isActive: true, createdAt: true,
          medico: true,
        },
      })
      if (!user) throw new NotFoundError('User')
      res.json(user)
    } catch (err) { next(err) }
  },
)

// PATCH /users/:id — update own profile
const UpdateProfileDto = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName:  z.string().min(1).max(100).optional(),
  especialidad: z.string().optional(),
  hospital:     z.string().optional(),
})

router.patch('/:id',
  auth,
  validate(UpdateProfileDto),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params
      if (req.user.sub !== id && req.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' })
        return
      }

      const { firstName, lastName, especialidad, hospital } = req.body

      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(firstName && { firstName }),
          ...(lastName  && { lastName }),
          ...(req.user.role === 'MEDICO' && (especialidad || hospital) && {
            medico: {
              update: {
                ...(especialidad && { especialidad }),
                ...(hospital     && { hospital }),
              },
            },
          }),
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          role: true, updatedAt: true, medico: true,
        },
      })
      res.json(user)
    } catch (err) { next(err) }
  },
)

// DELETE /users/:id — admin only (soft deactivate)
router.delete('/:id',
  auth,
  authorize('ADMIN') as RequestHandler,
  async (req, res: Response, next: NextFunction) => {
    try {
      await prisma.user.update({
        where: { id: req.params.id },
        data:  { isActive: false },
      })
      res.json({ success: true })
    } catch (err) { next(err) }
  },
)

export default router
