import { Router } from 'express'
import { validate } from '@/middlewares/validate'
import { authenticate, withAuth } from '@/middlewares/authenticate'
import { authLimiter } from '@/middlewares/rateLimiter'
import { RegisterDto, LoginDto, RefreshDto } from './auth.dto'
import * as ctrl from './auth.controller'
import type { AuthRequest } from '@/types'

const router = Router()

router.post('/register', authLimiter, validate(RegisterDto), ctrl.register)
router.post('/login',    authLimiter, validate(LoginDto),    ctrl.login)
router.post('/refresh',  validate(RefreshDto),               ctrl.refresh)
router.post('/logout',   ctrl.logout)
router.get('/me',        authenticate,     withAuth(ctrl.me))

export default router
