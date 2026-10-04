// NEW S2D — forecast orchestration errors (all technical / server-side).
import { AppError } from '@/lib/errors'

// The S-equivalent of S2C-FIX1: a resolved forecast-swap $transaction is not
// commit evidence; the exact committed state is re-read before any socket.
export class ForecastCommitVerificationError extends AppError {
  constructor(public readonly invariant: string) {
    super('Forecast state could not be confirmed in the database.', 500, 'FORECAST_COMMIT_NOT_VISIBLE')
  }
}

// Concurrent churn kept invalidating the candidate fingerprint after the
// bounded number of compute→lock→revalidate attempts. Nothing was written.
export class ForecastOrchestrationUnstableError extends AppError {
  constructor(public readonly attempts: number) {
    super('Forecast inputs kept changing during orchestration.', 500, 'FORECAST_ORCHESTRATION_UNSTABLE')
  }
}

// The S2B plan changed between the bridge-less and the bridge-identity
// fingerprint passes — bridge identity must never alter the clinical plan.
export class ForecastPlanInvariantError extends AppError {
  constructor(detail: string) {
    super(`Forecast plan invariant violated: ${detail}`, 500, 'FORECAST_PLAN_INVARIANT')
  }
}
