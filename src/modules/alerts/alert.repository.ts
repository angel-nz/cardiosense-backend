import { prisma } from '@/config/prisma'
import type { AlertSeverity, AlertType, Prisma } from '@prisma/client'

// Z5 — a doctor-visible Alert now has two mutually-exclusive ownership
// paths (see the schema.prisma Alert model comment for the full invariant):
// PATIENT-SCOPED (`patient.medicoId == medicoId`) or DOCTOR-SCOPED
// (`alert.medicoId == medicoId` directly). Z6-R2 — no live AlertType
// populates the doctor-scoped path anymore (its one producer, the
// doctor-profile information alert, was removed), but the mechanism is kept
// as generic infrastructure for any future doctor-scoped Alert, not deleted.
// Every query in this repository that decides "does this Alert belong to
// this doctor" composes this same OR — never patient-scoping alone — so a
// doctor-scoped Alert isn't invisibly dropped from lists/counts/mark-read.
// It is always nested inside the query's own top-level AND (alongside
// unread/severity/search), never merely one arm of the pre-existing search
// OR (U7.2 §6) — a foreign patient's data still can never leak in via the
// search branch.
// Z8 §30 — the patient-scoped branch now also excludes isHidden=true, so a
// hidden patient's persisted Alerts disappear from the normal Alerts
// surface (list/unreadCount/markAllRead — every consumer of this function)
// exactly like every other normal operational surface. The doctor-scoped
// branch (`{ medicoId }` directly) is completely untouched — "generic
// direct doctor-scoped Alert support remains" per the brief. No Alert row
// is ever deleted or rewritten by this — once the patient is shown again,
// their persisted patient-scoped alerts naturally become visible again
// through this same predicate.
function ownedByMedico(medicoId: string): Prisma.AlertWhereInput {
  return { OR: [{ patient: { medicoId, isHidden: false } }, { medicoId }] }
}

export class AlertRepository {
  // Z5 — patientId/medicoId are now both optional at the type level
  // (mirroring the nullable schema columns): callers are responsible for
  // supplying exactly one (AlertService.createInformationAlert enforces
  // this before ever reaching here; the pre-existing prediction-alert
  // caller in AlertService.create() continues to always pass patientId,
  // never medicoId). `type` is new and optional — omitted (undefined) for
  // every pre-existing prediction-alert call site, exactly matching the
  // nullable AlertType column.
  async create(data: {
    patientId?:    string
    medicoId?:     string
    predictionId?: string
    type?:         AlertType
    severity:      AlertSeverity
    message:       string
  }, client: Pick<Prisma.TransactionClient, 'alert'> = prisma) {
    // NEW R (R4E) — `client` lets PredictionService persist a prediction
    // Alert inside the SAME Prisma transaction as its Prediction. Every
    // other caller keeps the default (the shared client), unchanged.
    return client.alert.create({ data })
  }

  // U7.2 — search is ONE of three OR branches (name tokens, CURP, alert
  // message), always nested under the mandatory doctor-ownership predicate
  // (Z5: ownedByMedico, formerly `patient: { medicoId }` alone) — a foreign
  // patient's data can never make their Alerts visible regardless of which
  // branch matches. Doctor scoping stays a top-level AND predicate, never
  // merely one arm of the search OR (section 6).
  async findByMedico(medicoId: string, opts: {
    page:      number
    limit:     number
    unread?:   boolean
    severity?: AlertSeverity
    search?:   string
  }) {
    const { page, limit, unread, severity, search } = opts
    const skip = (page - 1) * limit

    let searchOr: Prisma.AlertWhereInput[] | undefined
    if (search) {
      const normalized = search.replace(/\s+/g, ' ')
      const tokens = normalized.split(' ').filter(Boolean)
      const curpCandidate = normalized.toUpperCase()
      searchOr = [
        {
          patient: {
            AND: tokens.map(token => ({
              OR: [
                { firstName: { contains: token, mode: 'insensitive' as const } },
                { lastName:  { contains: token, mode: 'insensitive' as const } },
              ],
            })),
          },
        },
        { patient: { curp: { contains: curpCandidate } } },
        { message: { contains: normalized, mode: 'insensitive' as const } },
      ]
    }

    // Z5 — composed as an explicit top-level AND array (rather than the
    // previous plain-object-with-spreads shape) specifically so
    // ownedByMedico()'s own OR and searchOr's OR can coexist as two
    // independent AND members — a single JS object literal cannot hold two
    // same-named `OR` keys, and merging them into one OR would have been
    // WRONG (it would let search alone satisfy ownership). Semantically
    // identical to before for every filter that isn't ownership itself.
    const where: Prisma.AlertWhereInput = {
      AND: [
        ownedByMedico(medicoId),
        ...(unread !== undefined ? [{ isRead: !unread }] : []),
        ...(severity ? [{ severity }] : []),
        ...(searchOr ? [{ OR: searchOr }] : []),
      ],
    }

    const [data, total] = await prisma.$transaction([
      prisma.alert.findMany({
        where,
        skip,
        take:    limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          patient: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.alert.count({ where }),
    ])

    const unreadCount = await prisma.alert.count({
      where: { AND: [ownedByMedico(medicoId), { isRead: false }] },
    })

    return { data, total, unreadCount }
  }

  async markRead(id: string) {
    return prisma.alert.update({ where: { id }, data: { isRead: true } })
  }

  async markAllRead(medicoId: string) {
    return prisma.alert.updateMany({
      where: { AND: [ownedByMedico(medicoId), { isRead: false }] },
      data:  { isRead: true },
    })
  }

  // Z5 — also includes `medico` (id only) alongside the pre-existing
  // `patient` include, so AlertService.markRead's ownership check (and any
  // other caller) can resolve either ownership path from one query, never
  // a second round-trip.
  async findById(id: string) {
    return prisma.alert.findUnique({
      where:   { id },
      include: { patient: true, medico: { select: { id: true } } },
    })
  }

  // Z2 — P2's Patient Timeline source (findInRangeForPatient) was removed:
  // it was used exclusively by patient.service.ts::getTimeline for the
  // now-deleted Alert-model timeline events, and by no other feature
  // (confirmed by repo-wide search before removal). The Alerts subsystem's
  // own read paths (findByMedico, findById, markRead, markAllRead) are
  // untouched by that removal; Z5 above is the only later change to any of
  // them.
}
