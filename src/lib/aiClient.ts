import axios from 'axios'
import { env } from '@/config/env'
import { logger } from '@/lib/logger'
import { ServiceUnavailableError } from '@/lib/errors'
import type { AIPredictionResponse } from '@/types'
import type { HealthRecord } from '@prisma/client'

const aiClient = axios.create({
  baseURL: env.AI_SERVICE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Key': env.AI_SERVICE_KEY,
  },
})

function buildFeatures(record: HealthRecord) {
  return {
    age:           record.age,
    sex:           0,   // Added in health record v2; default for now
    currentSmoker: record.currentSmoker ? 1 : 0,
    cigsPerDay:    record.cigsPerDay,
    BPMeds:        record.bpMeds ? 1 : 0,
    diabetes:      record.diabetes ? 1 : 0,
    totChol:       Number(record.totChol),
    sysBP:         Number(record.sysBP),
    diaBP:         Number(record.diaBP),
    BMI:           Number(record.bmi),
    heartRate:     record.heartRate,
    glucose:       Number(record.glucose),
  }
}

export async function callAIPredict(record: HealthRecord): Promise<AIPredictionResponse> {
  try {
    const payload = buildFeatures(record)
    logger.debug('Calling AI service', { payload })
    const { data } = await aiClient.post<AIPredictionResponse>('/predict', payload)
    return data
  } catch (err) {
    logger.error('AI service error', { err })
    // Q2-FIX: no mock/heuristic fallback of any kind, in any environment.
    // CardioSense has a real inference service (Skorp-Beta-0.1) — an
    // unreachable/failing AI Service is a genuine inference failure, not a
    // condition to silently paper over with a fabricated risk score. The
    // previous dev-mode fallback here is exactly what caused a mock
    // prediction (model_version: '1.2.0-mock') to be persisted and treated
    // as real when the AI Service was stopped.
    throw new ServiceUnavailableError('AI prediction')
  }
}
