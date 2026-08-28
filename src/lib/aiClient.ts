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

    // Fallback mock when AI service is unavailable (dev / demo mode)
    if (env.NODE_ENV !== 'production') {
      logger.warn('AI service unreachable — returning mock prediction')
      return mockPrediction(record)
    }

    throw new ServiceUnavailableError('AI prediction')
  }
}

// ─── Mock fallback for development ───────────────────────────────────────────
function mockPrediction(record: HealthRecord): AIPredictionResponse {
  const sysBP    = Number(record.sysBP)
  const totChol  = Number(record.totChol)
  const glucose  = Number(record.glucose)
  const age      = record.age
  const smoker   = record.currentSmoker ? 0.1 : 0

  // Simple heuristic score for demo purposes
  let score = 0
  if (sysBP > 140)  score += 0.25
  if (sysBP > 160)  score += 0.15
  if (totChol > 240) score += 0.15
  if (glucose > 110) score += 0.10
  if (age > 55)      score += 0.15
  if (age > 65)      score += 0.10
  score += smoker
  score = Math.min(Math.max(score, 0.05), 0.98)

  const risk_level = score < 0.35 ? 'low' : score < 0.65 ? 'moderate' : 'high'
  const anomaly_score = -(Math.random() * 0.3)

  return {
    risk_score: parseFloat(score.toFixed(4)),
    risk_level,
    anomaly_score: parseFloat(anomaly_score.toFixed(4)),
    is_anomaly: anomaly_score < -0.15,
    model_version: '1.2.0-mock',
    feature_importance: {
      sysBP:         0.22,
      age:           0.18,
      totChol:       0.14,
      BMI:           0.11,
      glucose:       0.10,
      heartRate:     0.08,
      currentSmoker: 0.09,
      diaBP:         0.08,
    },
  }
}
