import { prisma } from '@/config/prisma'
import type { Prisma } from '@prisma/client'
import type { ClinicalTimeSource } from '@prisma/client'
import type { CreateRecordDtoType } from './record.dto'

// Persistence input: `age` is required here because the service derives it
// from Paciente.birthDate before calling create() (record.service.ts). The
// HTTP DTO keeps `age` optional and never trusts a client-sent value.
// V-AGE-FIX-2 §3 — `recordedAt` is likewise now required here: the service
// derives both `age` and `recordedAt` from the same canonical `Date`
// instance and passes both through explicitly, rather than letting this
// column fall back to Prisma's `@default(now())` (a separate `now()`
// evaluation from the one used for `age`).
// NEW S2A — `measuredAt` + `clinicalTimeSource` are likewise required here
// (both server-derived in record.service.ts; there is no DB default for
// clinicalTimeSource, so a create path can never omit it).
type CreateHealthRecordData = Omit<CreateRecordDtoType, 'age'> & {
  age: number
  recordedAt: Date
  measuredAt: Date
  clinicalTimeSource: ClinicalTimeSource
}

export class HealthRecordRepository {
  // NEW S4 — optional transaction client: record.service creates the record
  // and its durable AutomaticPredictionTask atomically.
  async create(userId: string, dto: CreateHealthRecordData, client: Prisma.TransactionClient = prisma) {
    return client.healthRecord.create({
      data: {
        patientId:     dto.patientId,
        recordedAt:    dto.recordedAt,
        measuredAt:    dto.measuredAt,
        clinicalTimeSource: dto.clinicalTimeSource,
        age:           dto.age,
        currentSmoker: dto.currentSmoker,
        cigsPerDay:    dto.cigsPerDay,
        bpMeds:        dto.bpMeds,
        diabetes:      dto.diabetes,
        totChol:       dto.totChol,
        sysBP:         dto.sysBP,
        diaBP:         dto.diaBP,
        bmi:           dto.bmi,
        glucose:       dto.glucose,
        notes:         dto.notes,
        createdBy:     userId,
      },
    })
  }

  async findByPatient(patientId: string, limit: number) {
    return prisma.healthRecord.findMany({
      where:   { patientId },
      orderBy: { recordedAt: 'desc' },
      take:    limit,
    })
  }

  // U3.2 — added `id: 'desc'` tie-break for the (rare) case of two records
  // sharing an identical recordedAt — previously undefined/incidental
  // ordering for that exact tie. Safe, minimal addition; does not change
  // behavior for the overwhelming majority of cases where recordedAt
  // values differ.
  async findLatestByPatient(patientId: string) {
    return prisma.healthRecord.findFirst({
      where:   { patientId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    })
  }

  async findById(id: string) {
    return prisma.healthRecord.findUnique({ where: { id } })
  }

  // R1.5 — patient-scoped lookup. Returns the record ONLY if it belongs to
  // `patientId`; a record of any other patient (same doctor or not) is
  // indistinguishable from a nonexistent one (null). Callers that already
  // hold an authorized patient must use this instead of findById() so the
  // record-to-patient invariant is enforced by the query itself, never by
  // trusting a caller-supplied pairing.
  async findByIdForPatient(id: string, patientId: string) {
    return prisma.healthRecord.findFirst({ where: { id, patientId } })
  }

  // PRE-T-R1 / R-BPBC-3 — causal prior history for personalization evidence.
  // measuredAt is the ONLY causal clock. Strictly earlier measured rows are
  // candidates; measuredAt NULL rows are also fetched so the pure builder can
  // audit/exclude legacy time explicitly. Equal/future measured rows are not
  // prior evidence. recordedAt is intentionally absent from both predicate and
  // selected R payload.
  async findPriorRecordsForPatient(patientId: string, anchorId: string, cutoff: Date) {
    return prisma.healthRecord.findMany({
      where: {
        patientId,
        id: { not: anchorId },
        OR: [{ measuredAt: { lt: cutoff } }, { measuredAt: null }],
      },
      orderBy: [{ measuredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, patientId: true, measuredAt: true, clinicalTimeSource: true, age: true, currentSmoker: true,
        cigsPerDay: true, bpMeds: true, diabetes: true, totChol: true, sysBP: true,
        diaBP: true, bmi: true, glucose: true,
      },
    })
  }

  // P2 — Patient Timeline. Filters in DB (patientId + optional [from, to)),
  // ascending by recordedAt (the timeline's global sort order — see
  // patient.timeline.ts::sortTimelineEvents) with a stable id tie-break so
  // repeated requests with identical data return identical order.
  async findInRange(patientId: string, from?: Date, to?: Date) {
    return prisma.healthRecord.findMany({
      where: {
        patientId,
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
}
