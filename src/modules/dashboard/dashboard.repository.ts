import { prisma } from '@/config/prisma'
import { Prisma } from '@prisma/client'

export class DashboardRepository {
  // I1 — count only; scoping (patient.medicoId) applied inside Prisma, not
  // in application code.
  async countPredictionsInRange(medicoId: string, start: Date, end: Date): Promise<number> {
    return prisma.prediction.count({
      where: {
        patient: { medicoId },
        predictedAt: { gte: start, lt: end },
      },
    })
  }

  // I3 — only the timestamp is selected; bucketing by local day happens in
  // the service, over a dataset already bounded to one médico's one week.
  async findPredictedAtInRange(medicoId: string, start: Date, end: Date): Promise<Array<{ predictedAt: Date }>> {
    return prisma.prediction.findMany({
      where: {
        patient: { medicoId },
        predictedAt: { gte: start, lt: end },
      },
      select: { predictedAt: true },
    })
  }

  // I2/I4 — shared source: every patient of this médico (no pagination —
  // this is an aggregate, not a page) with only their single most recent
  // Prediction embedded (take: 1), same "current risk" definition already
  // used and validated by patient.repository.ts (Bloque B), reimplemented
  // here independently rather than imported, per the Bloque I instruction
  // to keep Dashboard's queries self-contained and auditable on their own.
  async findPatientsWithLatestRisk(medicoId: string): Promise<Array<{ predictions: Array<{ riskLevel: string }> }>> {
    return prisma.paciente.findMany({
      where: { medicoId },
      select: {
        predictions: {
          orderBy: { predictedAt: 'desc' },
          take: 1,
          select: { riskLevel: true },
        },
      },
    })
  }

  // ─── O2 — Dashboard Calendar ──────────────────────────────────────────
  // All four queries below apply `medicoId` directly inside Prisma (never
  // "fetch all, filter in application code") and are independent of each
  // other except for the predecessor query, which needs the patientIds
  // found by findPredictionsInRange first (see dashboard.service.ts).

  // O2.7 — patient identity for `patientName` decoration. One query for
  // ALL of the médico's patients, never one findUnique per event.
  async findPatientIdentities(medicoId: string): Promise<Array<{ id: string; firstName: string; lastName: string }>> {
    return prisma.paciente.findMany({
      where: { medicoId },
      select: { id: true, firstName: true, lastName: true },
    })
  }

  // O2.8 — CLINICAL_RECORD source. Same [from, to) + asc/id-tie-break
  // pattern as patient.timeline's record.repository.ts::findInRange, but
  // scoped by medicoId across all patients instead of a single patientId.
  async findRecordsInRange(medicoId: string, from?: Date, to?: Date): Promise<Array<{
    id: string
    patientId: string
    recordedAt: Date
    sysBP: unknown
    diaBP: unknown
  }>> {
    return prisma.healthRecord.findMany({
      where: {
        patient: { medicoId },
        ...(from || to ? {
          recordedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        } : {}),
      },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    })
  }

  // O2.9 — PREDICTION source, also the basis for `relevantPatientIds`
  // (dashboard.service.ts) used to scope the predecessor query below.
  async findPredictionsInRange(medicoId: string, from?: Date, to?: Date): Promise<Array<{
    id: string
    patientId: string
    healthRecordId: string | null
    predictedAt: Date
    riskScore: unknown
    riskLevel: string
    isAnomaly: boolean
    anomalyScore: unknown
    modelVersion: string | null
  }>> {
    return prisma.prediction.findMany({
      where: {
        patient: { medicoId },
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

  // O2.10 — ALERT source.
  //
  // W2.2 — same `include` added here as alert.repository.ts::findInRangeForPatient
  // (single JOIN inside this one findMany call, no N+1), so
  // dashboard.calendar.ts's reuse of toAlertEvent() can derive the same
  // deterministic groupId for the Dashboard's multi-patient view.
  async findAlertsInRange(medicoId: string, from?: Date, to?: Date): Promise<Array<{
    id: string
    patientId: string
    predictionId: string | null
    createdAt: Date
    severity: string
    message: string
    isRead: boolean
    prediction: { healthRecordId: string | null } | null
  }>> {
    return prisma.alert.findMany({
      where: {
        patient: { medicoId },
        ...(from || to ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        prediction: { select: { healthRecordId: true } },
      },
    })
  }

  // O2.11 — predecessor query. Real column/table names confirmed from
  // schema.prisma: table `predictions` (patient_id, predicted_at,
  // risk_level), table `pacientes` (medico_id). $queryRaw with a tagged
  // template — Prisma binds `medicoId`/`patientIds`/`from` as real query
  // parameters, never string-concatenated (never $queryRawUnsafe).
  //
  // Per O1-FIX: NOT Prisma Client's `distinct` (that fetches/processes
  // every Prediction older than `from` for the médico, unbounded by time);
  // this is PostgreSQL's own DISTINCT ON, the correct native "top-1 per
  // partition" construct, restricted to `patientIds` — i.e. only patients
  // that actually have a Prediction inside the requested range (callers
  // must pass an empty array check before calling; see
  // dashboard.service.ts, which skips this query entirely when there are
  // no relevant patients — section 17).
  //
  // Ownership is re-verified INSIDE this query (`pa.medico_id = ${medicoId}`
  // via the join) rather than trusting that the caller's `patientIds` list
  // was already safely scoped — defense in depth, matching how every other
  // query in this codebase re-applies its own scoping rather than relying
  // on an upstream filter.
  //
  // Tie-break: predicted_at DESC, id DESC — deterministic choice for this
  // new query (P2's own single-patient findPredecessor has no id tie-break;
  // not reopened here, just not propagated into this new one).
  // O2-FIX — patient_id is TEXT in this schema (confirmed directly from
  // migration.sql: `"patient_id" TEXT NOT NULL` — no native Postgres `uuid`
  // column anywhere in this project), so no ::uuid cast is actually needed
  // for correctness. But interpolating a raw JS array into `= ANY(${arr})`
  // inside a $queryRaw tagged template is not a documented-safe pattern in
  // Prisma for PostgreSQL regardless of column type — Prisma.join() is the
  // officially supported mechanism for a dynamic value list: it expands to
  // individual bound parameters ($1, $2, $3...) combined with `IN (...)`,
  // each parameter typed by its own JS value (string), with no array-typing
  // ambiguity at all.
  async findPredecessors(
    medicoId: string,
    patientIds: string[],
    before: Date,
  ): Promise<Array<{ id: string; patientId: string; predictedAt: Date; riskLevel: string }>> {
    if (patientIds.length === 0) return []
    return prisma.$queryRaw<Array<{ id: string; patientId: string; predictedAt: Date; riskLevel: string }>>`
      SELECT DISTINCT ON (p.patient_id)
        p.id,
        p.patient_id AS "patientId",
        p.predicted_at AS "predictedAt",
        p.risk_level AS "riskLevel"
      FROM predictions p
      JOIN pacientes pa ON pa.id = p.patient_id AND pa.medico_id = ${medicoId}
      WHERE p.patient_id IN (${Prisma.join(patientIds)})
        AND p.predicted_at < ${before}
      ORDER BY p.patient_id, p.predicted_at DESC, p.id DESC
    `
  }
}
