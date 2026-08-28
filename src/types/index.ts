import type { Request } from 'express'
import type { JwtPayload } from '@/lib/jwt'

// Augment Express Request with authenticated user
export interface AuthRequest extends Request {
  user: JwtPayload
}

// AI Service response shape
export interface AIPredictionResponse {
  risk_score: number
  risk_level: 'low' | 'moderate' | 'high'
  anomaly_score: number
  is_anomaly: boolean
  feature_importance: Record<string, number>
  model_version: string
}

// Pagination helpers
export interface PaginationQuery {
  page?: number
  limit?: number
}

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export function paginate<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) }
}
