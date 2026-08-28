import { Router } from 'express'
import { validate } from '@/middlewares/validate'
import { authenticate } from '@/middlewares/authenticate'
import { authLimiter } from '@/middlewares/rateLimiter'
import { RegisterDto, LoginDto, RefreshDto } from './auth.dto'
import * as ctrl from './auth.controller'
import type { AuthRequest } from '@/types'
import type { RequestHandler } from 'express'

const router = Router()

router.post('/register', authLimiter, validate(RegisterDto), ctrl.register)
router.post('/login',    authLimiter, validate(LoginDto),    ctrl.login)
router.post('/refresh',  validate(RefreshDto),               ctrl.refresh)
router.post('/logout',   ctrl.logout)
router.get('/me',        authenticate as RequestHandler,     ctrl.me as RequestHandler)

export default router
