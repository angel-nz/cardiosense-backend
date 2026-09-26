import { prisma } from '@/config/prisma'
import type { CreatePatientDtoType, UpdatePatientDtoType } from './patient.dto'
import type { RiskLevel, Prisma } from '@prisma/client'

export class PatientRepository {
  // X2 — `risk` filters the dataset BEFORE pagination, matching the EXACT
  // "current risk" semantics already established and validated by
  // dashboard.repository.ts::findPatientsWithLatestRisk / dashboard.service.ts's
  // summarizeRisk: the patient's single MOST RECENT Prediction (predictedAt
  // desc, take:1) has riskLevel === risk — deliberately NOT
  // `predictions: { some: { riskLevel } }`, which would mean "ever had this
  // riskLevel" (wrong — a patient whose latest Prediction is LOW but had an
  // old HIGH one must be excluded). Prisma has no native "filter by latest
  // related row" predicate, so the smallest correct strategy (no raw SQL,
  // no schema change, no approximation) is: resolve the candidate patient
  // ids whose latest Prediction matches in one prefilter query — reusing
  // the exact same medicoId+search scoping (`baseWhere`) so search and risk
  // compose correctly together — then apply that id set to the real
  // paginated/counted query below, so `total`/`totalPages` describe the
  // risk-filtered dataset itself, not an unfiltered page re-sliced
  // afterward. An empty `matchedIds` correctly yields zero rows/total via
  // `id: { in: [] }`, never a fabricated/approximated result.
  async findAll(medicoId: string, opts: {
    page: number; limit: number; search?: string; risk?: RiskLevel
  }) {
    const { page, limit, search, risk } = opts
    const skip = (page - 1) * limit

    const baseWhere: Prisma.PacienteWhereInput = {
      medicoId,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName:  { contains: search, mode: 'insensitive' as const } },
          { curp:      { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    }

    let where: Prisma.PacienteWhereInput = baseWhere
    if (risk) {
      const candidates = await prisma.paciente.findMany({
        where: baseWhere,
        select: {
          id: true,
          predictions: {
            orderBy: { predictedAt: 'desc' },
            take: 1,
            select: { riskLevel: true },
          },
        },
      })
      const matchedIds = candidates
        .filter(p => p.predictions[0]?.riskLevel === risk)
        .map(p => p.id)
      where = { ...baseWhere, id: { in: matchedIds } }
    }

    const [data, total] = await prisma.$transaction([
      prisma.paciente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          predictions: {
            orderBy: { predictedAt: 'desc' },
            take: 1,
            select: { riskLevel: true, riskScore: true, predictedAt: true },
          },
        },
      }),
      prisma.paciente.count({ where }),
    ])

    return { data, total }
  }

  async findById(id: string, medicoId: string) {
    return prisma.paciente.findFirst({
      where: { id, medicoId },
      include: {
        predictions: {
          orderBy: { predictedAt: 'desc' },
          take: 1,
          select: { riskLevel: true, riskScore: true, isAnomaly: true, predictedAt: true },
        },
      },
    })
  }

  async create(medicoId: string, dto: CreatePatientDtoType) {
    return prisma.paciente.create({
      data: {
        medicoId,
        firstName: dto.firstName,
        lastName:  dto.lastName,
        birthDate: new Date(dto.birthDate),
        sex:       dto.sex,
        curp:      dto.curp,
        phone:     dto.phone,
      },
    })
  }

  // U4.2A-FIX-2 — mirrors create()'s existing `new Date(dto.birthDate)`
  // convention, which update() was missing entirely (it previously passed
  // the raw "YYYY-MM-DD" string straight through to Prisma for a
  // DateTime/@db.Date column). `birthDate` is destructured out first so
  // `rest` never carries the raw string — only converted and re-added when
  // actually present, preserving UpdatePatientDto's optional semantics
  // (omitted → don't touch the column; the same `...rest` spread already
  // passes `curp: null`/`phone: null` straight through unchanged when the
  // doctor explicitly clears them).
  async update(id: string, dto: UpdatePatientDtoType) {
    const { birthDate, ...rest } = dto
    return prisma.paciente.update({
      where: { id },
      data: {
        ...rest,
        ...(birthDate !== undefined && { birthDate: new Date(birthDate) }),
      },
    })
  }

  async deactivate(id: string) {
    return prisma.paciente.update({ where: { id }, data: { isActive: false } })
  }

  // U5.2 — `records` gains pagination/sorting; `predictions` (last 20,
  // predictedAt desc) is completely unchanged — confirmed unused by the
  // frontend's Risk Evolution (which has its own independent endpoint,
  // GET /predictions/patient/:id), kept here only for response-contract
  // backward compatibility, not removed. sortBy is a closed Zod-enum
  // whitelist at the DTO layer — never arbitrary field interpolation.
  // Deterministic `{id: 'desc'}` secondary order breaks ties on the sort
  // column. Page is NOT clamped here — an out-of-range page legitimately
  // returns an empty `data` array with the real `total`/`totalPages`; the
  // frontend owns correcting its own visual page state from that.
  // U8.2B — optional `targetId` deep-link resolution. When present, the
  // requested `page` is IGNORED and instead resolved server-side: the
  // target row is looked up scoped by the exact same `where` (patientId +
  // active date filter) that the main query uses — a target excluded by
  // that filter, belonging to another patient, or nonexistent, is
  // reported as unavailable through the single `targetResolved: false`
  // outcome, indistinguishable from each other (never reveals which case
  // occurred, never fabricates the row into results). When found, the
  // number of rows preceding it under the EXACT SAME total order as the
  // main findMany (primary sortBy/sortOrder + secondary `id desc` — never
  // just the primary column alone) determines its page via
  // `floor(precedingCount / limit) + 1`. Normal callers that omit
  // `targetId` are entirely unaffected — the extra `targetResolved` field
  // is only ever present in the response when a `targetId` was supplied.
  async getHistory(patientId: string, opts: {
    page: number; limit: number; sortBy: string; sortOrder: 'asc' | 'desc'; from?: string; to?: string; targetId?: string
  }) {
    const { page, limit, sortBy, sortOrder, from, to, targetId } = opts
    const dateFilter = from || to ? {
      recordedAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to   ? { lte: new Date(to)   } : {}),
      },
    } : {}
    const where = { patientId, ...dateFilter }

    let resolvedPage = page
    let targetResolved: boolean | undefined
    if (targetId) {
      const target = await prisma.healthRecord.findFirst({ where: { ...where, id: targetId } })
      if (!target) {
        targetResolved = false
      } else {
        targetResolved = true
        const targetValue = (target as unknown as Record<string, unknown>)[sortBy]
        // Same total order as the main findMany below: primary
        // sortBy/sortOrder, secondary `id desc` — a row "precedes" the
        // target under `desc` when its value is strictly greater, or tied
        // with a strictly greater id. Under `asc`, the primary comparison
        // flips to `lt`, but the secondary tie-break stays `id: {gt}` —
        // it is NOT flipped, because the secondary order itself is always
        // `id desc` regardless of the primary column's direction.
        const precedingWhere = sortOrder === 'desc'
          ? { OR: [
              { [sortBy]: { gt: targetValue } },
              { AND: [{ [sortBy]: targetValue }, { id: { gt: target.id } }] },
            ] }
          : { OR: [
              { [sortBy]: { lt: targetValue } },
              { AND: [{ [sortBy]: targetValue }, { id: { gt: target.id } }] },
            ] }
        const precedingCount = await prisma.healthRecord.count({ where: { ...where, ...precedingWhere } })
        resolvedPage = Math.floor(precedingCount / limit) + 1
      }
    }
    const skip = (resolvedPage - 1) * limit

    const [data, total, predictions] = await prisma.$transaction([
      prisma.healthRecord.findMany({
        where,
        orderBy: [{ [sortBy]: sortOrder }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.healthRecord.count({ where }),
      prisma.prediction.findMany({
        where: { patientId },
        orderBy: { predictedAt: 'desc' },
        take: 20,
      }),
    ])

    return {
      records: { data, total, page: resolvedPage, limit, totalPages: Math.ceil(total / limit) },
      predictions,
      ...(targetId !== undefined ? { targetResolved } : {}),
    }
  }
}
