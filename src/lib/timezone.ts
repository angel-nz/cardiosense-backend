// Timezone-safe date/week boundary helpers for Dashboard metrics (Bloque I).
// No new dependency: Node's built-in Intl.DateTimeFormat already carries the
// full IANA tz database, which is what's actually needed here — a real
// date library (date-fns-tz, luxon, etc.) would be solving a problem this
// project doesn't have.
//
// Business timezone decision (closed, per Bloque I spec): America/Mexico_City.
// Week decision (closed): Monday–Sunday (ISO 8601).
import { z } from 'zod'

export const BUSINESS_TIMEZONE = 'America/Mexico_City'

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function getWallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value)
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
  }
}

// The real UTC instant corresponding to local 00:00:00 of `instant`'s
// calendar date in `timeZone`. Verified by hand-trace against
// America/Mexico_City (fixed UTC-6, no DST since the 2022 reform): local
// midnight there is always 06:00 UTC the same calendar day.
export function startOfLocalDay(instant: Date, timeZone: string = BUSINESS_TIMEZONE): Date {
  const wc = getWallClock(instant, timeZone)
  // The current wall-clock reading, reinterpreted as if it were itself UTC —
  // the delta between this and the real instant IS the timezone offset.
  const asIfUTC = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)
  const offsetMs = asIfUTC - instant.getTime()
  const localMidnightAsIfUTC = Date.UTC(wc.year, wc.month - 1, wc.day, 0, 0, 0)
  return new Date(localMidnightAsIfUTC - offsetMs)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

// UTC instant of local Monday 00:00:00 for the ISO week (Mon–Sun) containing
// `instant`, in `timeZone`.
export function startOfLocalWeek(instant: Date, timeZone: string = BUSINESS_TIMEZONE): Date {
  const dayStart = startOfLocalDay(instant, timeZone)
  const weekdayShort = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(dayStart)
  const offsetDays = WEEKDAY_INDEX[weekdayShort] ?? 0
  // Re-derive via startOfLocalDay (not raw ms subtraction) so this stays
  // correct even across a DST transition, should the business timezone
  // ever change to one that observes it.
  return startOfLocalDay(addDays(dayStart, -offsetDays), timeZone)
}

// Calendar date (YYYY-MM-DD) as perceived in `timeZone`, for labeling —
// not for query boundaries.
export function toLocalISODate(instant: Date, timeZone: string = BUSINESS_TIMEZONE): string {
  const wc = getWallClock(instant, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${wc.year}-${pad(wc.month)}-${pad(wc.day)}`
}

// ── NEW S2A — REAL clinical-time calendar helpers (S1-FIX1 §4) ────────────
// The clinical calendar is ALWAYS the business timezone's (Guadalajara),
// derived from the UTC instant through the IANA database (Intl) — never the
// machine, browser or PostgreSQL session timezone.

// Guadalajara clinical calendar day (YYYY-MM-DD) of a UTC instant.
export function clinicalDayOf(instant: Date): string {
  return toLocalISODate(instant, BUSINESS_TIMEZONE)
}

// A pure calendar date (YYYY-MM-DD) as the UTC-midnight Date — the same
// representation Prisma uses for @db.Date values (e.g. Paciente.birthDate),
// so calendar arithmetic on it must read UTC components only.
export function isoDateToUTCDate(isoDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new RangeError(`not a calendar date: ${isoDate}`)
  const d = new Date(`${isoDate}T00:00:00.000Z`)
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== isoDate) throw new RangeError(`invalid calendar date: ${isoDate}`)
  return d
}

// A @db.Date value (UTC midnight) back to its calendar date (YYYY-MM-DD).
export function utcDateToISODate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// U6.2 — extracted from patient.timeline.dto.ts (P2), the only prior
// implementation (dashboard.routes.ts already reuses TimelineQueryDto
// verbatim rather than duplicating this logic, so no other consumer needed
// updating for this move). ONE canonical implementation from here on;
// behavior is byte-for-byte unchanged from the original.
//
// Accepts either:
//   - a calendar date "YYYY-MM-DD", interpreted as a day boundary in the
//     project's business timezone (America/Mexico_City);
//   - a full ISO 8601 instant, used as-is.
//
// Deliberately NOT the `new Date(from)` pattern some older query params
// still use — that accepts any string (including garbage) and silently
// produces an `Invalid Date`. Here, an invalid value is rejected with a
// clean 400 via Zod instead (see boundaryField).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function parseBoundary(raw: string, edge: 'from' | 'to'): Date | null {
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
    // `to` is exclusive-upper (`lt`), matching the gte/lt convention used
    // throughout this project — the start of the NEXT day makes the given
    // day fully included without an off-by-one.
    return edge === 'from' ? dayStart : addDays(dayStart, 1)
  }
  const parsed = new Date(raw)
  return isNaN(parsed.getTime()) ? null : parsed
}

export function boundaryField(edge: 'from' | 'to') {
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
