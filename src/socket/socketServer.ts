import type { Server as HTTPServer } from 'http'
import { Server as IOServer } from 'socket.io'
import { verifyAccessToken } from '@/lib/jwt'
import { logger } from '@/lib/logger'
import { env } from '@/config/env'

export function setupSocket(httpServer: HTTPServer): IOServer {
  const io = new IOServer(httpServer, {
    cors: {
      origin:      env.FRONTEND_URL,
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  })

  // ─── Auth middleware ──────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth.token as string | undefined
    if (!token) {
      return next(new Error('Authentication token required'))
    }
    try {
      const payload      = verifyAccessToken(token)
      socket.data.userId = payload.sub
      socket.data.role   = payload.role
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  // ─── Connection handler ───────────────────────────────────────────
  io.on('connection', socket => {
    const userId = socket.data.userId as string
    logger.debug(`[Socket] connected: ${socket.id} (user: ${userId})`)

    // Auto-join personal room
    void socket.join(`user:${userId}`)

    // Subscribe to a patient's room
    socket.on('subscribe_patient', (patientId: string) => {
      if (typeof patientId !== 'string') return
      void socket.join(`patient:${patientId}`)
      logger.debug(`[Socket] ${userId} subscribed to patient:${patientId}`)
    })

    // Unsubscribe from a patient's room
    socket.on('unsubscribe_patient', (patientId: string) => {
      if (typeof patientId !== 'string') return
      void socket.leave(`patient:${patientId}`)
    })

    // Ping/pong keepalive
    socket.on('ping', () => socket.emit('pong'))

    socket.on('disconnect', reason => {
      logger.debug(`[Socket] disconnected: ${socket.id} (${reason})`)
    })
  })

  return io
}
