// NEW S2D — RiskForecastSet / RiskForecast persistence.
//
// Reads use the global client (or a supplied one). Every WRITE takes the
// orchestrator's transaction client: there is no write path outside the
// accepted lock → revalidate → swap sequence. The DB UNIQUE on
// risk_forecast_sets.current_for_patient_id (S2A) stays the final guard for
// "at most one CURRENT set per patient".
import { prisma } from '@/config/prisma'
import type { Prisma, ForecastSupersedeReason } from '@prisma/client'

export type Tx = Prisma.TransactionClient

const WITH_FORECASTS = { forecasts: { orderBy: { horizonIndex: 'asc' as const } } }

export type ForecastSetWithForecasts = Prisma.RiskForecastSetGetPayload<{ include: typeof WITH_FORECASTS }>

// ── reads ──────────────────────────────────────────────────────────────
export function findCurrentSet(patientId: string, client: Tx | typeof prisma = prisma) {
  return (client as Tx).riskForecastSet.findUnique({ where: { currentForPatientId: patientId } })
}

export function findCurrentSetWithForecasts(patientId: string, client: Tx | typeof prisma = prisma): Promise<ForecastSetWithForecasts | null> {
  return (client as Tx).riskForecastSet.findUnique({ where: { currentForPatientId: patientId }, include: WITH_FORECASTS })
}

export function findSetById(id: string, client: Tx | typeof prisma = prisma): Promise<ForecastSetWithForecasts | null> {
  return (client as Tx).riskForecastSet.findUnique({ where: { id }, include: WITH_FORECASTS })
}

// Superseded history, newest first; deterministic tie-break on id.
export async function findSupersededHistory(patientId: string, page: number, limit: number) {
  const where = { patientId, currentForPatientId: null }
  const [data, total] = await Promise.all([
    prisma.riskForecastSet.findMany({
      where, include: WITH_FORECASTS,
      orderBy: [{ supersededAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit, take: limit,
    }),
    prisma.riskForecastSet.count({ where }),
  ])
  return { data, total }
}

// ── writes (transaction client only) ────────────────────────────────────
export async function lockPatientForecasts(tx: Tx, patientId: string): Promise<void> {
  // Cross-process, transaction-scoped, deterministic per patient.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cardiosense:risk-forecast:' + patientId}, 0))`
}

export async function supersedeCurrent(tx: Tx, setId: string, reason: ForecastSupersedeReason, at: Date): Promise<void> {
  await tx.riskForecastSet.update({
    where: { id: setId },
    data: { currentForPatientId: null, supersededAt: at, supersedeReason: reason },
  })
}

export async function linkSupersededBy(tx: Tx, oldSetId: string, newSetId: string): Promise<void> {
  await tx.riskForecastSet.update({ where: { id: oldSetId }, data: { supersededBySetId: newSetId } })
}

export async function insertCurrentSet(tx: Tx, data: Prisma.RiskForecastSetUncheckedCreateInput): Promise<void> {
  await tx.riskForecastSet.create({ data })
}

export async function insertForecasts(tx: Tx, rows: Prisma.RiskForecastCreateManyInput[]): Promise<void> {
  if (rows.length) await tx.riskForecast.createMany({ data: rows })
}
