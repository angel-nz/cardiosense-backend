// NEW S2D — trigger boundary. Every REAL-source integration (HealthRecord
// created, Prediction verified, demographics changed, patient reactivated,
// visibility changes) calls these AFTER its own operation committed. Forecast
// failures are caught and logged here and NEVER propagate into (or roll back)
// the source operation; bootstrap / later triggers reconcile.
import type { Server as IOServer } from 'socket.io'
import type { ForecastTrigger } from '@prisma/client'
import { logger } from '@/lib/logger'
import { orchestrateForecast, reconcileLifecycleForDoctor, reconcileLifecycleForPatients } from './forecast.orchestrator'

const inFlight = new Set<Promise<unknown>>()

function track(p: Promise<unknown>): void {
  inFlight.add(p)
  p.finally(() => inFlight.delete(p))
}

const describe = (err: unknown) => ({
  code: (err as { code?: string })?.code ?? null,
  errorType: err instanceof Error ? err.name : typeof err,
})

// NEW S4-FIX1 — the tracked orchestration as an awaitable promise that NEVER
// rejects (a forecast failure is logged and swallowed exactly as before).
// The canonical automatic-Prediction finalizer awaits it so the durable task
// is COMPLETED only after the S opportunity for the persisted Prediction has
// actually run (or failed-and-been-logged), not merely been queued.
export function runForecastOrchestration(patientId: string, trigger: ForecastTrigger, io?: IOServer): Promise<void> {
  const p = orchestrateForecast({ patientId, trigger, io }).then(() => undefined, err => {
    logger.error('Forecast orchestration failed (source operation unaffected)', { patientId, trigger, ...describe(err) })
  })
  track(p)
  return p
}

export function scheduleForecastOrchestration(patientId: string, trigger: ForecastTrigger, io?: IOServer): void {
  void runForecastOrchestration(patientId, trigger, io)
}

export function scheduleLifecycleReconcile(target: { patientIds?: string[]; doctorId?: string }, io?: IOServer): void {
  const run = target.doctorId ? reconcileLifecycleForDoctor(target.doctorId, io) : reconcileLifecycleForPatients(target.patientIds ?? [], io)
  track(run.catch(err => {
    logger.error('Forecast lifecycle reconcile failed (source operation unaffected)', { ...describe(err) })
  }))
}

// Test / CLI helper: resolves when every scheduled orchestration settled.
export async function waitForForecastTriggersIdle(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight])
}
