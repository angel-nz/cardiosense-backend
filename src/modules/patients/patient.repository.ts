import { prisma } from '@/config/prisma'
import { currentPredictionsOfLatestClinicalRecord, orderPatientIdsByLatestClinical } from './clinicalLatest'
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
  // NEW S3-FIX1 — SUPERSEDED rationale below: "current risk" is now the
  // Prediction of the patient's EXACT clinically latest HealthRecord
  // (clinicalLatest.ts::currentPredictionsOfLatestClinicalRecord), shared
  // with the dashboard distribution; the historical X2 text is kept for audit.
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
  // the exact same doctorId+search+status scoping (`baseWhere`) so search,
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
  async findAll(doctorId: string, opts: {
    page: number; limit: number; search?: string; risk?: RiskLevel; status: PatientStatusFilter
  }) {
    const { page, limit, search, risk, status } = opts
    const skip = (page - 1) * limit

    const baseWhere: Prisma.PatientWhereInput = {
      doctorId,
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

    // NEW S3 — clinical-time-first: "current risk" = the Prediction of the
    // EXACT clinically latest record (S3-FIX1 strict rule: no Prediction on
    // that record ⇒ no current risk ⇒ matches no risk filter), and the default order is
    // the patient's latest CLINICAL time DESC (never Paciente.updatedAt,
    // which only reflects personal-info edits). Both are resolved dataset-
    // wide BEFORE pagination; `total` uses the same filtered id set.
    let ids = (await prisma.patient.findMany({ where: baseWhere, select: { id: true } })).map(p => p.id)
    if (risk) {
      const latest = await currentPredictionsOfLatestClinicalRecord(ids)
      ids = ids.filter(id => latest.get(id)?.riskLevel === risk)
    }
    const ordered = await orderPatientIdsByLatestClinical(ids)
    const pageIds = ordered.slice(skip, skip + limit)
    const rows = pageIds.length ? await prisma.patient.findMany({ where: { id: { in: pageIds } } }) : []
    const byId = new Map(rows.map(r => [r.id, r]))
    const data = pageIds.map(id => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined)
    return { data, total: ids.length }
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
  async findById(id: string, doctorId: string) {
    return prisma.patient.findFirst({
      where: { id, doctorId, isHidden: false },
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
  async findHiddenById(id: string, doctorId: string) {
    return prisma.patient.findFirst({ where: { id, doctorId, isHidden: true } })
  }

  async create(doctorId: string, dto: CreatePatientDtoType) {
    return prisma.patient.create({
      data: {
        doctorId,
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
    return prisma.patient.update({
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
  // NEW S2D — optional transaction client so a deactivation can supersede
  // the patient's CURRENT forecast set in the SAME transaction.
  async setActive(id: string, isActive: boolean, client: Pick<Prisma.TransactionClient, 'patient'> = prisma) {
    return client.patient.update({ where: { id }, data: { isActive } })
  }

  // Z8 §10/§11 — one explicit, reversible visibility setter for BOTH
  // directions. Never touches `isActive` — HIDE/SHOW are a purely separate
  // axis from deactivate/reactivate (Z8 §9/§35's "no endpoint silently
  // combines show+reactivate or deactivate+hide"). The caller
  // (PatientService.hide/show) has already enforced every precondition
  // (owned, exists, current isActive/isHidden state, the
  // PatientMustBeInactiveToHideError business rule) before this is reached.
  async setHidden(id: string, isHidden: boolean) {
    return prisma.patient.update({ where: { id }, data: { isHidden } })
  }

  // Z8 §19 — bulk visibility. Scoped by this WHERE alone (doctorId +
  // isActive=false + the CURRENT isHidden value being flipped) — never a
  // two-step "find ids then update", so there is no window where a
  // concurrent change could cause an id collected in step 1 to be
  // (wrongly) updated in step 2. Prisma's updateMany returns `{ count }`,
  // the exact affectedCount Z8 §19 requires — it only ever touches rows
  // matching every one of these predicates: an ACTIVE patient is never
  // touched (isActive: false is unconditional here, not merely the
  // "default" case), and another doctor's patients are never touched
  // (doctorId is always the authenticated doctor's own Medico.id, never
  // client-suppliable).
  async bulkSetVisibility(doctorId: string, isHidden: boolean): Promise<number> {
    const result = await prisma.patient.updateMany({
      where: { doctorId, isActive: false, isHidden: !isHidden },
      data:  { isHidden },
    })
    return result.count
  }

  // Z8 §17 — the Settings -> Pacientes hidden-patient list. Deliberately
  // minimal: no `predictions`/`healthRecords` include at all (Z8's own
  // "do not return clinical records/predictions here — this is visibility
  // management, not another PatientDetail implementation" instruction) —
  // just enough fields for a row's name/basic identity + a "Mostrar"
  // action. Scoped to doctorId + isActive=false + isHidden=true
  // unconditionally — this is the ONE query in this repository allowed to
  // resolve hidden rows as a *list* (findHiddenById above is the equivalent
  // for a single id).
  async findHidden(doctorId: string, opts: { page: number; limit: number; search?: string }) {
    const { page, limit, search } = opts
    const skip = (page - 1) * limit
    const where: Prisma.PatientWhereInput = {
      doctorId,
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
      prisma.patient.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true, firstName: true, lastName: true, birthDate: true, sex: true,
          curp: true, updatedAt: true,
        },
      }),
      prisma.patient.count({ where }),
    ])
    return { data, total }
  }

  // Z8 §18 — Settings -> Pacientes summary counts. Both scoped to the
  // current doctor alone; deliberately allowed to count hidden patients
  // (hiddenInactive) — this IS the dedicated visibility-management surface
  // the Z8 brief carves out that exception for (never reused as a Dashboard
  // patient count — see dashboard.repository.ts, which excludes hidden
  // patients from every one of ITS counts instead).
  async getVisibilitySummary(doctorId: string): Promise<{ visibleInactive: number; hiddenInactive: number }> {
    const [visibleInactive, hiddenInactive] = await Promise.all([
      prisma.patient.count({ where: { doctorId, isActive: false, isHidden: false } }),
      prisma.patient.count({ where: { doctorId, isActive: false, isHidden: true } }),
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
    if (sortBy === 'clinicalTime') return this.getHistoryByClinicalTime(patientId, { page, limit, sortOrder, from, to, targetId })
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

  // NEW S2E-FIX2 — Clinical History ordered by EFFECTIVE CLINICAL TIME,
  // globally (before OFFSET/LIMIT), read-only:
  //   effective = measured_at  when clinical_time_source = 'CLINICIAN_ENTERED'
  //               (and measured_at is present),
  //               recorded_at  otherwise (legacy rows; a malformed
  //               CLINICIAN_ENTERED row without measured_at also falls back to
  //               recorded_at — it is never presented as measured).
  //   DESC: effective DESC, recorded_at DESC, id DESC
  //   ASC:  effective ASC,  recorded_at ASC,  id ASC
  // `id` compares bytewise (COLLATE "C") so the tie-break is a fixed total
  // order. Prisma's orderBy cannot express the COALESCE, so the ordered id
  // page is selected with a parameterized $queryRaw (all values are bound
  // parameters; the direction is chosen between two fixed statements — no
  // string interpolation), then the full rows are loaded by id and returned
  // in that exact order. The optional from/to filter keeps its existing
  // recorded_at semantics. targetId resolution uses the SAME total order
  // (row_number over the identical ORDER BY). HealthRecord persistence and
  // every R/S read path are untouched.
  private async getHistoryByClinicalTime(patientId: string, opts: {
    page: number; limit: number; sortOrder: 'asc' | 'desc'; from?: string; to?: string; targetId?: string
  }) {
    const { page, limit, sortOrder, targetId } = opts
    const fromIso = opts.from ? new Date(opts.from).toISOString() : null
    const toIso = opts.to ? new Date(opts.to).toISOString() : null
    const where = {
      patientId,
      ...(opts.from || opts.to ? { recordedAt: { ...(opts.from ? { gte: new Date(opts.from) } : {}), ...(opts.to ? { lte: new Date(opts.to) } : {}) } } : {}),
    }

    let resolvedPage = page
    let targetResolved: boolean | undefined
    if (targetId) {
      const rows = (sortOrder === 'desc'
        ? await prisma.$queryRaw`
            SELECT pos::int AS pos FROM (
              SELECT id, row_number() OVER (ORDER BY
                COALESCE(CASE WHEN clinical_time_source = 'CLINICIAN_ENTERED' THEN measured_at END, recorded_at) DESC,
                recorded_at DESC, id COLLATE "C" DESC) - 1 AS pos
              FROM health_records
              WHERE patient_id = ${patientId}
                AND (${fromIso}::text IS NULL OR recorded_at >= (${fromIso}::timestamptz AT TIME ZONE 'UTC'))
                AND (${toIso}::text IS NULL OR recorded_at <= (${toIso}::timestamptz AT TIME ZONE 'UTC'))
            ) s WHERE id = ${targetId}`
        : await prisma.$queryRaw`
            SELECT pos::int AS pos FROM (
              SELECT id, row_number() OVER (ORDER BY
                COALESCE(CASE WHEN clinical_time_source = 'CLINICIAN_ENTERED' THEN measured_at END, recorded_at) ASC,
                recorded_at ASC, id COLLATE "C" ASC) - 1 AS pos
              FROM health_records
              WHERE patient_id = ${patientId}
                AND (${fromIso}::text IS NULL OR recorded_at >= (${fromIso}::timestamptz AT TIME ZONE 'UTC'))
                AND (${toIso}::text IS NULL OR recorded_at <= (${toIso}::timestamptz AT TIME ZONE 'UTC'))
            ) s WHERE id = ${targetId}`) as { pos: number }[]
      if (rows.length === 0) {
        targetResolved = false
      } else {
        targetResolved = true
        resolvedPage = Math.floor(Number(rows[0].pos) / limit) + 1
      }
    }
    const skip = (resolvedPage - 1) * limit

    const [idRows, total, predictions] = await prisma.$transaction([
      sortOrder === 'desc'
        ? prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM health_records
            WHERE patient_id = ${patientId}
              AND (${fromIso}::text IS NULL OR recorded_at >= (${fromIso}::timestamptz AT TIME ZONE 'UTC'))
              AND (${toIso}::text IS NULL OR recorded_at <= (${toIso}::timestamptz AT TIME ZONE 'UTC'))
            ORDER BY COALESCE(CASE WHEN clinical_time_source = 'CLINICIAN_ENTERED' THEN measured_at END, recorded_at) DESC,
                     recorded_at DESC, id COLLATE "C" DESC
            OFFSET ${skip} LIMIT ${limit}`
        : prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM health_records
            WHERE patient_id = ${patientId}
              AND (${fromIso}::text IS NULL OR recorded_at >= (${fromIso}::timestamptz AT TIME ZONE 'UTC'))
              AND (${toIso}::text IS NULL OR recorded_at <= (${toIso}::timestamptz AT TIME ZONE 'UTC'))
            ORDER BY COALESCE(CASE WHEN clinical_time_source = 'CLINICIAN_ENTERED' THEN measured_at END, recorded_at) ASC,
                     recorded_at ASC, id COLLATE "C" ASC
            OFFSET ${skip} LIMIT ${limit}`,
      prisma.healthRecord.count({ where }),
      prisma.prediction.findMany({ where: { patientId }, orderBy: { predictedAt: 'desc' }, take: 20 }),
    ])
    const ids = idRows.map(r => r.id)
    const byId = new Map((ids.length ? await prisma.healthRecord.findMany({ where: { id: { in: ids }, patientId } }) : []).map(r => [r.id, r]))
    const data = ids.map(id => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined)

    return {
      records: { data, total, page: resolvedPage, limit, totalPages: Math.ceil(total / limit) },
      predictions,
      ...(targetId !== undefined ? { targetResolved } : {}),
    }
  }
}
