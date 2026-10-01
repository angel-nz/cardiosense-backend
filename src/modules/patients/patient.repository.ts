import { prisma } from '@/config/prisma'
import type { CreatePatientDtoType, UpdatePatientDtoType } from './patient.dto'
import type { RiskLevel, Prisma } from '@prisma/client'

// Z8 — the Patients-list lifecycle filter. ACTIVE/INACTIVE/ALL as the Z8
// brief defines them (section 12): hidden patients are excluded from every
// one of these three — never something the caller can opt out of here —
// the ONLY way to reach a hidden patient's row is the dedicated
// findHidden()/findHiddenById() methods further below, reserved for the
// visibility-management surface.
export type PatientStatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL'

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
  // the exact same medicoId+search+status scoping (`baseWhere`) so search,
  // risk and lifecycle status compose correctly together — then apply that
  // id set to the real paginated/counted query below, so `total`/
  // `totalPages` describe the risk-filtered dataset itself, not an
  // unfiltered page re-sliced afterward. An empty `matchedIds` correctly
  // yields zero rows/total via `id: { in: [] }`, never a fabricated/
  // approximated result.
  //
  // Z8 — `status` (ACTIVE/INACTIVE/ALL) added. `baseWhere` ALWAYS includes
  // `isHidden: false`, unconditionally — this is the one, single place that
  // guarantees a hidden patient can never surface through the normal
  // Patients-list API regardless of which status/search/risk combination is
  // requested (Z8 §12/§14: "Do not rely on frontend local filtering" /
  // "Hidden patients NEVER appear in these three normal filters"). `total`
  // below is computed from this SAME `where` the result rows use, so
  // pagination can never imply more/fewer patients exist than the filtered
  // set actually has (Z8 §13's "pagination total must use exactly the same
  // predicate as result rows").
  async findAll(medicoId: string, opts: {
    page: number; limit: number; search?: string; risk?: RiskLevel; status: PatientStatusFilter
  }) {
    const { page, limit, search, risk, status } = opts
    const skip = (page - 1) * limit

    const baseWhere: Prisma.PacienteWhereInput = {
      medicoId,
      isHidden: false,
      ...(status === 'ACTIVE'   && { isActive: true }),
      ...(status === 'INACTIVE' && { isActive: false }),
      // status === 'ALL' adds no isActive predicate at all — active AND
      // inactive-visible rows both match, hidden rows never do (isHidden:
      // false above already excludes them unconditionally).
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

  // Z8 §26 — every standard Doctor-facing patient read/write (GET/PUT
  // /patients/:id, timeline, history, the status endpoint's own lookup, new
  // record/prediction ownership resolution) goes through this one method
  // (directly or via PatientService.getOne()), and it now excludes
  // `isHidden: true` unconditionally. A hidden patient therefore behaves
  // exactly like a nonexistent/foreign one everywhere this is the ownership
  // check — the same NotFoundError('Patient') every caller already throws
  // on a null result, never a distinct "exists but hidden" response. An
  // INACTIVE_VISIBLE patient is NOT excluded here — historical information
  // (clinical history, timeline) stays fully accessible for it, per Z8 §25/
  // §33; only hidden patients are walled off at this layer.
  async findById(id: string, medicoId: string) {
    return prisma.paciente.findFirst({
      where: { id, medicoId, isHidden: false },
      include: {
        predictions: {
          orderBy: { predictedAt: 'desc' },
          take: 1,
          select: { riskLevel: true, riskScore: true, isAnomaly: true, predictedAt: true },
        },
      },
    })
  }

  // Z8 §10/§26 — the ONE deliberate exception to findById()'s isHidden:
  // false scoping: the visibility endpoint's SHOW direction must resolve a
  // patient that IS currently hidden, in order to un-hide it. Scoped to
  // isHidden: true specifically (not "any" patient) — a currently-visible
  // patient can never be "shown" through this path, and a wrong-doctor or
  // nonexistent id still resolves to nothing, same NotFoundError contract
  // as every other patient lookup in this module.
  async findHiddenById(id: string, medicoId: string) {
    return prisma.paciente.findFirst({ where: { id, medicoId, isHidden: true } })
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
        // Z6 — already trimmed/lowercased/validated (or null) by
        // CreatePatientDto's PatientEmailField; nothing left to do here.
        email:     dto.email,
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

  // Z8 §6/§7/§47 — replaces the old deactivate()/DELETE-route pairing
  // entirely. One explicit, reversible lifecycle setter for BOTH
  // directions (deactivate: isActive=false, reactivate: isActive=true) —
  // never a HTTP DELETE, never repurposed to mean hide. The caller
  // (PatientService.setStatus) has already resolved/validated the patient
  // (ownership, not-hidden, hidden-cannot-reactivate-directly) before this
  // is reached; this method is the bare, unconditional write.
  async setActive(id: string, isActive: boolean) {
    return prisma.paciente.update({ where: { id }, data: { isActive } })
  }

  // Z8 §10/§11 — one explicit, reversible visibility setter for BOTH
  // directions. Never touches `isActive` — HIDE/SHOW are a purely separate
  // axis from deactivate/reactivate (Z8 §9/§35's "no endpoint silently
  // combines show+reactivate or deactivate+hide"). The caller
  // (PatientService.hide/show) has already enforced every precondition
  // (owned, exists, current isActive/isHidden state, the
  // PatientMustBeInactiveToHideError business rule) before this is reached.
  async setHidden(id: string, isHidden: boolean) {
    return prisma.paciente.update({ where: { id }, data: { isHidden } })
  }

  // Z8 §19 — bulk visibility. Scoped by this WHERE alone (medicoId +
  // isActive=false + the CURRENT isHidden value being flipped) — never a
  // two-step "find ids then update", so there is no window where a
  // concurrent change could cause an id collected in step 1 to be
  // (wrongly) updated in step 2. Prisma's updateMany returns `{ count }`,
  // the exact affectedCount Z8 §19 requires — it only ever touches rows
  // matching every one of these predicates: an ACTIVE patient is never
  // touched (isActive: false is unconditional here, not merely the
  // "default" case), and another doctor's patients are never touched
  // (medicoId is always the authenticated doctor's own Medico.id, never
  // client-suppliable).
  async bulkSetVisibility(medicoId: string, isHidden: boolean): Promise<number> {
    const result = await prisma.paciente.updateMany({
      where: { medicoId, isActive: false, isHidden: !isHidden },
      data:  { isHidden },
    })
    return result.count
  }

  // Z8 §17 — the Settings -> Pacientes hidden-patient list. Deliberately
  // minimal: no `predictions`/`healthRecords` include at all (Z8's own
  // "do not return clinical records/predictions here — this is visibility
  // management, not another PatientDetail implementation" instruction) —
  // just enough fields for a row's name/basic identity + a "Mostrar"
  // action. Scoped to medicoId + isActive=false + isHidden=true
  // unconditionally — this is the ONE query in this repository allowed to
  // resolve hidden rows as a *list* (findHiddenById above is the equivalent
  // for a single id).
  async findHidden(medicoId: string, opts: { page: number; limit: number; search?: string }) {
    const { page, limit, search } = opts
    const skip = (page - 1) * limit
    const where: Prisma.PacienteWhereInput = {
      medicoId,
      isActive: false,
      isHidden: true,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName:  { contains: search, mode: 'insensitive' as const } },
          { curp:      { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    }

    const [data, total] = await prisma.$transaction([
      prisma.paciente.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true, firstName: true, lastName: true, birthDate: true, sex: true,
          curp: true, updatedAt: true,
        },
      }),
      prisma.paciente.count({ where }),
    ])
    return { data, total }
  }

  // Z8 §18 — Settings -> Pacientes summary counts. Both scoped to the
  // current doctor alone; deliberately allowed to count hidden patients
  // (hiddenInactive) — this IS the dedicated visibility-management surface
  // the Z8 brief carves out that exception for (never reused as a Dashboard
  // patient count — see dashboard.repository.ts, which excludes hidden
  // patients from every one of ITS counts instead).
  async getVisibilitySummary(medicoId: string): Promise<{ visibleInactive: number; hiddenInactive: number }> {
    const [visibleInactive, hiddenInactive] = await Promise.all([
      prisma.paciente.count({ where: { medicoId, isActive: false, isHidden: false } }),
      prisma.paciente.count({ where: { medicoId, isActive: false, isHidden: true } }),
    ])
    return { visibleInactive, hiddenInactive }
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
