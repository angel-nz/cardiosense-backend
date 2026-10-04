import http from 'http'
import { env } from '@/config/env'
import { createApp } from '@/app'
import { setupSocket } from '@/socket/socketServer'
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'
import { automaticPredictionWorker, isAutomaticPredictionWorkerDisabled } from '@/modules/predictions/automatic/automaticPrediction.worker'

// Q2-FIX: process-level safety net. Without this, ANY unhandled promise
// rejection anywhere in the app — not just in the automatic-prediction
// orchestration added in Q2 — crashes the entire Node process (Node's
// default `--unhandled-rejections` behavior since v15 is to treat an
// unhandled rejection as an uncaught exception). The automatic-prediction
// call site already has its own `.catch()` (record.service.ts), so this is
// deliberately a last-resort net, not a substitute for handling errors at
// their source — it only logs and keeps the server alive; it never exits
// the process, since an isolated background failure (e.g. AI Service down)
// must never take down the whole API.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason })
})
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err })
})

async function bootstrap() {
  // Verify DB connection
  try {
    await prisma.$connect()
    logger.info('✅ PostgreSQL connected')
  } catch (err) {
    logger.error('❌ PostgreSQL connection failed', { err })
    process.exit(1)
  }

  // Create HTTP server
  const httpServer = http.createServer()

  // Setup Socket.IO
  const io = setupSocket(httpServer)
  logger.info('✅ Socket.IO initialized')

  // Create Express app (inject io for real-time events)
  const app = createApp(io)
  httpServer.on('request', app)

  // NEW S4 — durable automatic-Prediction worker: immediate startup recovery
  // of due PENDING / RETRY_WAIT / lease-expired PROCESSING tasks, then
  // periodic polling. Independent of any frontend connection.
  if (!isAutomaticPredictionWorkerDisabled()) automaticPredictionWorker.start(io)

  // Start listening
  const port = parseInt(env.PORT, 10)
  httpServer.listen(port, () => {
    logger.info(`🚀 CardioSense API running on port ${port} [${env.NODE_ENV}]`)
    logger.info(`   Health: http://localhost:${port}/health`)
    logger.info(`   API:    http://localhost:${port}/api`)
  })

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down...`)
    await automaticPredictionWorker.stop()     // NEW S4 — no new ticks; await the pass in flight
    await prisma.$disconnect()
    httpServer.close(() => {
      logger.info('Server closed')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

bootstrap().catch(err => {
  logger.error('Bootstrap failed', { err })
  process.exit(1)
})
