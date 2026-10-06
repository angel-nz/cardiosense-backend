export interface ShutdownLogger {
  info(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface GracefulShutdownDependencies {
  closeTransport(): Promise<void>
  stopBackgroundWork(): Promise<void>
  disconnectPrisma(): Promise<void>
  exit(code: number): void
  logger: ShutdownLogger
  timeoutMs?: number
}

export interface ShutdownRequest {
  reason: string
  exitCode: number
  error?: unknown
}

function safeErrorMeta(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined) return undefined
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message }
  }
  return { errorType: typeof error }
}

export function createGracefulShutdown(deps: GracefulShutdownDependencies) {
  const timeoutMs = deps.timeoutMs ?? 10_000
  let shutdownPromise: Promise<void> | null = null
  let requestedExitCode = 0
  let exitRequested = false

  const requestExitOnce = (code: number) => {
    if (exitRequested) return
    exitRequested = true
    deps.exit(code)
  }

  const runStep = async (component: string, action: () => Promise<void>) => {
    try {
      await action()
    } catch (error) {
      requestedExitCode = Math.max(requestedExitCode, 1)
      deps.logger.error('Graceful shutdown cleanup failed', {
        component,
        ...safeErrorMeta(error),
      })
    }
  }

  const shutdown = (request: ShutdownRequest): Promise<void> => {
    // A fatal request that arrives while a normal signal shutdown is already
    // running upgrades the final exit code without starting cleanup twice.
    requestedExitCode = Math.max(requestedExitCode, request.exitCode)
    if (shutdownPromise) return shutdownPromise

    shutdownPromise = (async () => {
      deps.logger.info('Graceful shutdown started', {
        reason: request.reason,
        requestedExitCode,
        ...safeErrorMeta(request.error),
      })

      const timeout = setTimeout(() => {
        requestedExitCode = Math.max(requestedExitCode, request.exitCode)
        deps.logger.error('Graceful shutdown timed out; forcing process exit', {
          reason: request.reason,
          timeoutMs,
          exitCode: requestedExitCode,
        })
        requestExitOnce(requestedExitCode || 1)
      }, timeoutMs)
      timeout.unref?.()

      try {
        // Socket.IO owns the transport lifecycle because it is attached
        // directly to the HTTP server. io.close() closes Socket.IO clients,
        // Engine.IO, and the attached HTTP server; do not independently call
        // httpServer.close() from this shutdown path.
        await runStep('transport', deps.closeTransport)
        await runStep('automaticPredictionWorker', deps.stopBackgroundWork)
        await runStep('prisma', deps.disconnectPrisma)
      } finally {
        clearTimeout(timeout)
        deps.logger.info('Graceful shutdown completed', {
          reason: request.reason,
          exitCode: requestedExitCode,
        })
        requestExitOnce(requestedExitCode)
      }
    })()

    return shutdownPromise
  }

  return {
    shutdown,
    isShuttingDown: () => shutdownPromise !== null,
  }
}
