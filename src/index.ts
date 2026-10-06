import http from 'http'
import { env } from '@/config/env'
import { createApp } from '@/app'
import { setupSocket } from '@/socket/socketServer'
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'
import { automaticPredictionWorker, isAutomaticPredictionWorkerDisabled } from '@/modules/predictions/automatic/automaticPrediction.worker'
import { createGracefulShutdown } from '@/runtime/gracefulShutdown'

let shutdownController: ReturnType<typeof createGracefulShutdown> | null = null
let earlyFatalShutdown: Promise<void> | null = null

function requestProcessShutdown(reason: string, exitCode: number, error?: unknown): Promise<void> {
  if (shutdownController) {
    return shutdownController.shutdown({ reason, exitCode, error })
  }

  // A fatal failure before bootstrap has installed the full resource-aware
  // controller still must not leave an unknown process state running.
  if (!earlyFatalShutdown) {
    earlyFatalShutdown = (async () => {
      logger.error('Fatal process error before graceful shutdown was initialized', {
        reason,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : undefined,
      })
      try {
        await prisma.$disconnect()
      } catch (disconnectError) {
        logger.error('Prisma disconnect failed during early fatal shutdown', {
          errorName: disconnectError instanceof Error ? disconnectError.name : typeof disconnectError,
        })
      } finally {
        process.exit(exitCode)
      }
    })()
  }
  return earlyFatalShutdown
}

// INTEGRITY-1B — truly process-level failures are fatal. Expected operational
// async failures must be caught at their component boundary; reaching either
// of these handlers means process state is no longer trusted, so perform the
// one controlled shutdown path and terminate non-zero.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection — initiating fatal shutdown', {
    errorName: reason instanceof Error ? reason.name : undefined,
    errorMessage: reason instanceof Error ? reason.message : undefined,
  })
  void requestProcessShutdown('UNHANDLED_REJECTION', 1, reason)
})
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — initiating fatal shutdown', {
    errorName: err.name,
    errorMessage: err.message,
    stack: env.NODE_ENV === 'development' ? err.stack : undefined,
  })
  void requestProcessShutdown('UNCAUGHT_EXCEPTION', 1, err)
})

async function bootstrap() {
  // Verify DB connection
  try {
    await prisma.$connect()
    logger.info('✅ PostgreSQL connected')
  } catch (err) {
    logger.error('❌ PostgreSQL connection failed', { err })
    await requestProcessShutdown('BOOTSTRAP_DB_CONNECTION_FAILED', 1, err)
    return
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

  // Socket.IO is attached directly to this HTTP server and therefore owns
  // transport shutdown. io.close() closes Socket.IO/Engine.IO and the
  // underlying HTTP server, so there must be no independent httpServer.close()
  // request in the same graceful-shutdown sequence.
  const closeTransport = () => new Promise<void>((resolve) => {
    io.close(() => resolve())
  })

  shutdownController = createGracefulShutdown({
    closeTransport,
    stopBackgroundWork: () => automaticPredictionWorker.stop(),
    disconnectPrisma: () => prisma.$disconnect(),
    exit: code => process.exit(code),
    logger,
    timeoutMs: 10_000,
  })

  // Start listening
  const port = parseInt(env.PORT, 10)
  httpServer.listen(port, () => {
    logger.info(`🚀 CardioSense API running on port ${port} [${env.NODE_ENV}]`)
    logger.info(`   Health: http://localhost:${port}/health`)
    logger.info(`   API:    http://localhost:${port}/api`)
  })

  // All normal/fatal shutdown requests converge on the same idempotent
  // Promise. A fatal request arriving during a signal shutdown upgrades the
  // eventual exit code to non-zero but never starts cleanup a second time.
  process.on('SIGTERM', () => { void requestProcessShutdown('SIGTERM', 0) })
  process.on('SIGINT',  () => { void requestProcessShutdown('SIGINT', 0) })
}

bootstrap().catch(err => {
  logger.error('Bootstrap failed', {
    errorName: err instanceof Error ? err.name : typeof err,
    errorMessage: err instanceof Error ? err.message : undefined,
  })
  void requestProcessShutdown('BOOTSTRAP_FAILED', 1, err)
})
