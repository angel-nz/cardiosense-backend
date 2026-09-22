import { prisma } from '@/config/prisma'
import type { RiskLevel } from '@prisma/client'

export class PredictionRepository {
  async create(data: {
    patientId:     string
    healthRecordId?: string
    riskScore:     number
    riskLevel:     RiskLevel
    anomalyScore:  number
    isAnomaly:     boolean
    modelVersion:  string
  }) {
    return prisma.prediction.create({ data })
  }

  // U8.2B — added deterministic `id desc` secondary tie-break (previously
  // only `predictedAt desc` — a minor inconsistency versus every other
  // paginated module in this project, harmless before but now load-bearing
  // for the total-order target-page resolution below to be well-defined).
  // Optional `targetId`: same resolution principle as
  // patient.repository.ts::getHistory — when present, `page` is ignored
  // and instead resolved by counting Predictions that precede the target
  // under this EXACT total order (predictedAt desc, id desc). A target
  // that doesn't exist or belongs to another patient is reported through
  // the single `targetResolved: false` outcome, never fabricated into
  // results. Normal callers omitting `targetId` are entirely unaffected.
  async findByPatient(patientId: string, opts: { page: number; limit: number; targetId?: string }) {
    const { page, limit, targetId } = opts
    const where = { patientId }

    let resolvedPage = page
    let targetResolved: boolean | undefined
    if (targetId) {
      const target = await prisma.prediction.findFirst({ where: { ...where, id: targetId } })
      if (!target) {
        targetResolved = false
      } else {
        targetResolved = true
        const precedingCount = await prisma.prediction.count({
          where: {
            ...where,
            OR: [
              { predictedAt: { gt: target.predictedAt } },
              { AND: [{ predictedAt: target.predictedAt }, { id: { gt: target.id } }] },
            ],
          },
        })
        resolvedPage = Math.floor(precedingCount / limit) + 1
      }
    }
    const skip = (resolvedPage - 1) * limit

    const [data, total] = await prisma.$transaction([
      prisma.prediction.findMany({
        where,
        orderBy: [{ predictedAt: 'desc' }, { id: 'desc' }],
        skip,
        take:    limit,
      }),
      prisma.prediction.count({ where }),
    ])
    return { data, total, page: resolvedPage, targetResolved }
  }

  async findById(id: string) {
    return prisma.prediction.findUnique({ where: { id } })
  }

  async findLatestByPatient(patientId: string) {
    return prisma.prediction.findFirst({
      where:   { patientId },
      orderBy: { predictedAt: 'desc' },
    })
  }

  // U6.2 — global doctor-scoped history: search (name tokens AND'd, each
  // token matching firstName OR lastName; OR the full normalized string as
  // a CURP match — never applying individual tokens to CURP), optional
  // date range (half-open [from, to), already-converted Date instants from
  // GlobalPredictionQueryDto), optional single riskLevel. All predicates
  // compose with top-level AND, applied before count/skip/take, so
  // total/totalPages describe the FILTERED collection. `curp` now
  // included in the selected patient fields (needed by the redesigned
  // page); still scoped strictly inside `medicoId` — a foreign patient can
  // never match, search or otherwise.
  async listAll(medicoId: string, opts: {
    page: number; limit: number; search?: string; from?: Date; to?: Date; riskLevel?: RiskLevel
  }) {
    const { page, limit, search, from, to, riskLevel } = opts
    const skip = (page - 1) * limit

    const patientWhere: { medicoId: string; OR?: unknown[] } = { medicoId }
    if (search) {
      // Collapse repeated internal whitespace (already trimmed by the DTO).
      const normalized = search.replace(/\s+/g, ' ')
      const tokens = normalized.split(' ').filter(Boolean)
      const curpCandidate = normalized.toUpperCase()
      patientWhere.OR = [
        {
          AND: tokens.map(token => ({
            OR: [
              { firstName: { contains: token, mode: 'insensitive' as const } },
              { lastName:  { contains: token, mode: 'insensitive' as const } },
            ],
          })),
        },
        { curp: { contains: curpCandidate } },
      ]
    }

    const where = {
      patient: patientWhere,
      ...(riskLevel ? { riskLevel } : {}),
      ...(from || to ? {
        predictedAt: {
          ...(from ? { gte: from } : {}),
          ...(to   ? { lt: to }    : {}),
        },
      } : {}),
    }

    const [data, total] = await prisma.$transaction([
      prisma.prediction.findMany({
        where,
        orderBy: [{ predictedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: {
          patient: { select: { firstName: true, lastName: true, curp: true } },
        },
      }),
      prisma.prediction.count({ where }),
    ])
    return { data, total }
  }

  async findByIdForMedico(id: string, medicoId: string) {
    return prisma.prediction.findFirst({
      where: { id, patient: { medicoId } },
    })
  }

  // P2 — Patient Timeline. Same [from, to) DB filter and asc+id ordering
  // as HealthRecordRepository.findInRange — also used, unsorted-again, as
  // the base sequence for RISK_CHANGE derivation.
  async findInRange(patientId: string, from?: Date, to?: Date) {
    return prisma.prediction.findMany({
      where: {
        patientId,
        ...(from || to ? {
          predictedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        } : {}),
      },
      orderBy: [{ predictedAt: 'asc' }, { id: 'asc' }],
    })
  }

  // P2 — Patient Timeline range-boundary case (section 19): the single
  // most recent Prediction strictly before `before`, used ONLY as context
  // to derive a RISK_CHANGE whose *current* Prediction is inside the
  // requested range — never returned as a PREDICTION event itself.
  async findPredecessor(patientId: string, before: Date) {
    return prisma.prediction.findFirst({
      where: { patientId, predictedAt: { lt: before } },
      orderBy: { predictedAt: 'desc' },
    })
  }
}
