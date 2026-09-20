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
