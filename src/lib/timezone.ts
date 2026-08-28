// Timezone-safe date/week boundary helpers for Dashboard metrics (Bloque I).
// No new dependency: Node's built-in Intl.DateTimeFormat already carries the
// full IANA tz database, which is what's actually needed here — a real
// date library (date-fns-tz, luxon, etc.) would be solving a problem this
// project doesn't have.
//
// Business timezone decision (closed, per Bloque I spec): America/Mexico_City.
// Week decision (closed): Monday–Sunday (ISO 8601).

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
