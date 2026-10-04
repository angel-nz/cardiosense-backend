// NEW S2B — S-TIME-1: REAL clinical ordering and pure calendar arithmetic.
//
// S-only. R stays frozen on its own recordedAt (entry-time) semantics; this
// module never touches R code or R evidence.

import { clinicalDayOf } from '@/lib/timezone'
import { SInputContractError, type SRealRecordInput } from './types'

const isValidDate = (d: unknown): d is Date => d instanceof Date && !isNaN(d.getTime())

// Effective clinical instant of a REAL record:
//   CLINICIAN_ENTERED → measuredAt (must be present)
//   LEGACY_ENTRY_TIME → recordedAt, as a marked fallback (measuredAt must be null)
// Any other combination violates the S2A invariant and fails closed.
export function effectiveClinicalInstant(r: SRealRecordInput): Date {
  if (!isValidDate(r.recordedAt)) throw new SInputContractError(`record ${r.id}: recordedAt is not a valid instant`)
  if (r.clinicalTimeSource === 'CLINICIAN_ENTERED') {
    if (!isValidDate(r.measuredAt)) throw new SInputContractError(`record ${r.id}: CLINICIAN_ENTERED without a valid measuredAt`)
    return r.measuredAt
  }
  if (r.clinicalTimeSource === 'LEGACY_ENTRY_TIME') {
    if (r.measuredAt !== null) throw new SInputContractError(`record ${r.id}: LEGACY_ENTRY_TIME with a measuredAt`)
    return r.recordedAt
  }
  throw new SInputContractError(`record ${r.id}: unknown clinicalTimeSource ${String((r as { clinicalTimeSource: unknown }).clinicalTimeSource)}`)
}

// Deterministic S clinical order: effective clinical instant ↑, recordedAt ↑,
// id ↑ (plain code-unit comparison — locale independent). Never relies on
// the physical order the database returned. Returns a new array.
export function sortByClinicalOrder<T extends SRealRecordInput>(records: readonly T[]): T[] {
  const keyed = records.map(r => ({ r, t: effectiveClinicalInstant(r).getTime(), e: r.recordedAt.getTime() }))
  const ids = new Set<string>()
  for (const k of keyed) {
    if (ids.has(k.r.id)) throw new SInputContractError(`duplicate record id ${k.r.id}`)
    ids.add(k.r.id)
  }
  keyed.sort((a, b) => (a.t - b.t) || (a.e - b.e) || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0))
  return keyed.map(k => k.r)
}

// Guadalajara local clinical calendar day (YYYY-MM-DD) of an instant.
export const localClinicalDay = (instant: Date): string => clinicalDayOf(instant)

// ── Pure calendar-date arithmetic (no instants, no milliseconds) ──────────
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseISODate(iso: string): [number, number, number] {
  const m = DATE_RE.exec(iso)
  if (!m) throw new SInputContractError(`not a calendar date: ${iso}`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new SInputContractError(`invalid calendar date: ${iso}`)
  }
  return [y, mo, d]
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

// Calendar date + n days, by proleptic-Gregorian field normalization
// (Date.UTC(y, m, d + n)) — month/year boundaries and leap days included.
export function addCalendarDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new SInputContractError(`non-integer day offset ${days}`)
  const [y, m, d] = parseISODate(iso)
  const r = new Date(Date.UTC(y, m - 1, d + days))
  return `${pad(r.getUTCFullYear(), 4)}-${pad(r.getUTCMonth() + 1)}-${pad(r.getUTCDate())}`
}

// Whole calendar days from `a` to `b` (b − a).
export function calendarDayDiff(a: string, b: string): number {
  const [ya, ma, da] = parseISODate(a)
  const [yb, mb, db] = parseISODate(b)
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000)
}

// Calendar date → UTC-midnight Date (the @db.Date representation used by
// lib/age.ts calculateAge).
export function calendarDateToUTCDate(iso: string): Date {
  const [y, m, d] = parseISODate(iso)
  return new Date(Date.UTC(y, m - 1, d))
}

export const assertCalendarDate = (iso: string): void => { parseISODate(iso) }
