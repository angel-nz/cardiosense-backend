import { z } from 'zod'
import { startOfLocalDay, addDays } from '@/lib/timezone'

// Accepts either:
//   - a calendar date "YYYY-MM-DD", interpreted as a day boundary in the
//     project's business timezone (see lib/timezone.ts — same
//     America/Mexico_City convention already used by the Dashboard);
//   - a full ISO 8601 instant, used as-is.
//
// Deliberately NOT reusing patient.repository.ts::getHistory's existing
// `new Date(from)` pattern for query params — that accepts any string
// (including garbage) and silently produces an `Invalid Date`, which
// Prisma then either mishandles or throws an opaque error on. Here, an
// invalid value is rejected with a clean 400 via Zod instead.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function parseBoundary(raw: string, edge: 'from' | 'to'): Date | null {
  if (DATE_ONLY.test(raw)) {
    // Anchor at noon UTC so this guess always falls on the same calendar
    // date in America/Mexico_City (fixed UTC-6) as the literal Y-M-D,
    // regardless of the anchor's own UTC offset from that date's local
    // midnight — startOfLocalDay then derives the correct
    // local-midnight-as-UTC instant from that guess.
    const guess = new Date(`${raw}T12:00:00Z`)
    if (isNaN(guess.getTime())) return null
    const dayStart = startOfLocalDay(guess)
    // `from` is inclusive of the whole calendar day → its own start.
    // `to` is exclusive-upper (`lt`), matching the gte/lt convention
    // already used by dashboard.service.ts — the start of the NEXT day
    // makes the given day fully included without an off-by-one.
    return edge === 'from' ? dayStart : addDays(dayStart, 1)
  }
  const parsed = new Date(raw)
  return isNaN(parsed.getTime()) ? null : parsed
}

function boundaryField(edge: 'from' | 'to') {
  return z.string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined
      const parsed = parseBoundary(raw, edge)
      if (!parsed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid date for "${edge}"` })
        return z.NEVER
      }
      return parsed
    })
}

export const TimelineQueryDto = z.object({
  from: boundaryField('from'),
  to:   boundaryField('to'),
}).refine(
  data => !data.from || !data.to || data.from <= data.to,
  { message: '"from" must not be after "to"', path: ['from'] },
)

export type TimelineQueryDtoType = z.infer<typeof TimelineQueryDto>

export const TimelineParamDto = z.object({
  patientId: z.string().uuid('Invalid patient id'),
})
