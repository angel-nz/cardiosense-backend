// NEW S2D — canonical model contract supplied to the S2B planner.
//
// SOURCE: the AI service's own GET /health (model_version +
// eligible_age_range), read through the EXISTING backend capability client
// (lib/aiClient.ts → getModelCapabilities, which fails closed with 503 when the
// contract is unavailable). The age domain is owned by the model artifact
// (metadata.json) — never hard-coded in S code. /forecast/score's
// expected_model_version remains the decisive runtime guard.
//
// A short in-process cache serves read paths (API versionStale) and bulk
// bootstrap; orchestration may request a fresh read.
import { getModelCapabilities } from '@/lib/aiClient'
import type { SModelContractInput } from './domain/types'

const TTL_MS = 60_000
let cached: { at: number; value: SModelContractInput } | null = null

export async function getCurrentModelContract(opts: { fresh?: boolean } = {}): Promise<SModelContractInput> {
  if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value
  const caps = await getModelCapabilities()
  const value: SModelContractInput = {
    modelVersion: caps.modelVersion,
    eligibleAgeRange: { min: caps.eligibleAgeRange.min, max: caps.eligibleAgeRange.max },
  }
  cached = { at: Date.now(), value }
  return value
}

// Non-throwing variant for read paths (API versionStale).
export async function tryGetCurrentModelContract(): Promise<SModelContractInput | null> {
  try { return await getCurrentModelContract() } catch { return null }
}

export function _resetModelContractCacheForTests(): void { cached = null }
