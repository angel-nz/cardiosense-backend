import { prisma } from '@/config/prisma'
import type { RiskLevel, Prisma } from '@prisma/client'

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
  //
  // W5.2 — from/to/riskLevel added (additive). `where` is built ONCE below
  // and reused, by the same object reference, by every query in this
  // method — the targetId lookup, the precedingCount, the total count, and
  // the findMany — exactly mirroring listAll's existing filter-composition
  // pattern (same gte/lt half-open convention, same `riskLevel` direct
  // equality, no score-threshold reinterpretation). This is what
  // guarantees filters apply BEFORE pagination AND before target-page
  // resolution with no special-casing: a targetId that exists for this
  // patient but falls outside the active from/to/riskLevel filters simply
  // fails the SAME `where`-scoped lookup as a nonexistent/foreign one —
  // targetResolved=false, resolvedPage silently stays the originally
  // requested page (never mutated in that branch), filters are never
  // touched.
  async findByPatient(patientId: string, opts: {
    page: number; limit: number; targetId?: string
    from?: Date; to?: Date; riskLevel?: RiskLevel
  }) {
    const { page, limit, targetId, from, to, riskLevel } = opts
    const where = {
      patientId,
      ...(riskLevel ? { riskLevel } : {}),
      ...(from || to ? {
        predictedAt: {
          ...(from ? { gte: from } : {}),
          ...(to   ? { lt: to }    : {}),
        },
      } : {}),
    }

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

    // V7 — includes the linked HealthRecord (Prediction.healthRecordId is
    // nullable, so this can be `null` for legacy/unlinked Predictions —
    // never substituted with the patient's latest record or any other
    // record). A single `include` inside the SAME findMany query — Prisma
    // resolves this as one JOIN, not a query per row, so pagination stays
    // exactly as before and no N+1 is introduced.
    const [data, total] = await prisma.$transaction([
      prisma.prediction.findMany({
        where,
        orderBy: [{ predictedAt: 'desc' }, { id: 'desc' }],
        skip,
        take:    limit,
        include: { healthRecord: true },
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

    const patientWhere: Prisma.PacienteWhereInput = { medicoId }
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

    // V7 — same include-based relation load as findByPatient above, added
    // alongside the existing `patient` include in this SAME findMany call
    // (still one query, one JOIN) — no additional round trip.
    const [data, total] = await prisma.$transaction([
      prisma.prediction.findMany({
        where,
        orderBy: [{ predictedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: {
          patient:      { select: { firstName: true, lastName: true, curp: true } },
          healthRecord: true,
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
