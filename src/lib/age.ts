import { clinicalDayOf, isoDateToUTCDate } from './timezone'

// U3.2 — calendar-age calculation, backend-authoritative (record.service.ts
// is the only caller). Pure UTC calendar comparison — never
// milliseconds/365, never `referenceYear - birthYear` without a birthday
// check. `birthDate` (Paciente, @db.Date) and any `referenceDate` passed in
// must be compared using UTC components only: @db.Date values have no time
// component, so reading them with local Date methods risks an off-by-one
// day shift depending on the server/browser timezone — UTC getters avoid
// that entirely.
export function calculateAge(birthDate: Date, referenceDate: Date): number {
  let age = referenceDate.getUTCFullYear() - birthDate.getUTCFullYear()
  const monthDiff = referenceDate.getUTCMonth() - birthDate.getUTCMonth()
  const dayDiff = referenceDate.getUTCDate() - birthDate.getUTCDate()
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age--
  return age
}

// NEW S2A — age on the Guadalajara CLINICAL calendar day of a UTC instant
// (S1-FIX1 §4.7). Example: 2026-10-03T02:00Z is still 2026-10-02 in
// Guadalajara, so a patient born 1970-10-03 is 55 here, not 56 (the plain
// UTC-calendar calculateAge(birthDate, instant) would say 56).
export function calculateAgeAtClinicalTime(birthDate: Date, measuredAt: Date): number {
  return calculateAge(birthDate, isoDateToUTCDate(clinicalDayOf(measuredAt)))
}
