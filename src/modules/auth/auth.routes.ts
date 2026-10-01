import { Router } from 'express'
import { validate } from '@/middlewares/validate'
import { authenticate, authenticateForLogout, withAuth } from '@/middlewares/authenticate'
import { authLimiter } from '@/middlewares/rateLimiter'
import { RegisterDto, LoginDto } from './auth.dto'
import * as ctrl from './auth.controller'
import type { AuthRequest } from '@/types'

const router = Router()

router.post('/register', authLimiter, validate(RegisterDto), ctrl.register)
router.post('/login',    authLimiter, validate(LoginDto),    ctrl.login)
// Y5.2 — no body DTO: the refresh credential is the HttpOnly
// `cardiosense_refresh` cookie only (read inside the controller/service),
// never a JSON field. Both already sit under the global `apiLimiter`
// (mounted on `/api` in app.ts) like every other route in this file; no
// additional dedicated limiter is added here — refresh does not verify a
// guessable secret the way login/register's password check does (the
// refresh credential is a cryptographically random, unguessable signed
// JWT), so the brute-force risk `authLimiter` exists for does not apply
// the same way. This was a deliberate scope decision, not an oversight —
// flagged explicitly in the Y5.2 report rather than silently added or
// silently skipped.
router.post('/refresh',  ctrl.refresh)
// Y8D2b — logout's identity now comes from the access JWT's own `sid`
// (Y8C-R2 §11 "refresh cookie is for refresh only"), so it needs an
// authenticated identity in place BEFORE the handler runs — but
// deliberately the narrow `authenticateForLogout` (crypto-only, no
// active-session DB check), not the ordinary `authenticate`: logout's own
// contract is "terminate my session unconditionally," so an
// already-revoked session or a transient DB outage during an active-
// session check must never block reaching the handler and clearing local
// state/cookie (see middlewares/authenticate.ts for the full reasoning).
// `withAuth` still guards the handler itself against a missing `req.user`.
router.post('/logout',   authenticateForLogout, withAuth(ctrl.logout))
router.get('/me',        authenticate,     withAuth(ctrl.me))

export default router
