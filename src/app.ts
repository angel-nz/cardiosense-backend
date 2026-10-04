import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import morgan from 'morgan'
import mongoSanitize from 'express-mongo-sanitize'
import type { Server as IOServer } from 'socket.io'

import { env } from '@/config/env'
import { apiLimiter } from '@/middlewares/rateLimiter'
import { errorHandler } from '@/middlewares/errorHandler'
import { logger } from '@/lib/logger'

import authRoutes    from '@/modules/auth/auth.routes'
import userRoutes    from '@/modules/users/user.routes'
import dashboardRoutes from '@/modules/dashboard/dashboard.routes'
import { createPatientRouter } from '@/modules/patients/patient.routes'
import { createRecordRouter }  from '@/modules/health-records/record.routes'
import { createPredictionRouter } from '@/modules/predictions/prediction.routes'
import { createAlertRouter }      from '@/modules/alerts/alert.routes'
import { createRiskForecastRouter } from '@/modules/risk-forecasts/forecast.routes'  // NEW S2D

export function createApp(io?: IOServer) {
  const app = express()

  // ─── Security headers ───────────────────────────────────────────
  app.use(helmet())

  // ─── CORS ───────────────────────────────────────────────────────
  app.use(cors({
    origin:      env.FRONTEND_URL,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }))

  // ─── Cookie parsing (Y5.2 — reads the HttpOnly refresh-session cookie) ──
  // No secret passed to cookie-parser: this app does not use its built-in
  // signed-cookie feature — the refresh cookie's integrity comes from it
  // being a signed JWT (verified in lib/jwt.ts), not from cookie-parser's
  // own signing, so introducing a second, redundant signing mechanism here
  // would add complexity with no real protection gained.
  app.use(cookieParser())

  // ─── Body parsing ───────────────────────────────────────────────
  app.use(express.json({ limit: '10kb' }))
  app.use(express.urlencoded({ extended: true, limit: '10kb' }))

  // ─── Compression ────────────────────────────────────────────────
  app.use(compression())

  // ─── Sanitize NoSQL injection ────────────────────────────────────
  app.use(mongoSanitize())

  // ─── HTTP logging ────────────────────────────────────────────────
  if (env.NODE_ENV !== 'test') {
    app.use(morgan('dev', {
      stream: { write: msg => logger.http(msg.trim()) },
    }))
  }

  // ─── Rate limit ──────────────────────────────────────────────────
  app.use('/api', apiLimiter)

  // ─── Health check ────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status:  'ok',
      service: 'cardiosense-api',
      version: '1.0.0',
      ts:      new Date().toISOString(),
    })
  })

  // ─── Routes ──────────────────────────────────────────────────────
  app.use('/api/auth',           authRoutes)
  app.use('/api/users',          userRoutes)
  app.use('/api/dashboard',      dashboardRoutes)
  app.use('/api/patients',       createPatientRouter(io))
  app.use('/api/health-records', createRecordRouter(io))
  app.use('/api/predictions',    createPredictionRouter(io))
  app.use('/api/alerts',         createAlertRouter(io))
  app.use('/api/risk-forecasts', createRiskForecastRouter())   // NEW S2D — read-only projections

  // ─── 404 ─────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' })
  })

  // ─── Global error handler ────────────────────────────────────────
  app.use(errorHandler)

  return app
}
