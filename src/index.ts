import http from 'http'
import { env } from '@/config/env'
import { createApp } from '@/app'
import { setupSocket } from '@/socket/socketServer'
import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'

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
