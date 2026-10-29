import { calculateAge } from '@/lib/age'

// SORT-SEARCH-STICKY-FIX-1 (FIX-1 / FIX-2) — pure ordering helpers for the
// Patients list. They are applied to the COMPLETE filtered patient-id set
// BEFORE pagination (patient.repository.ts::findAll), never to a page.

export type PatientSortBy = 'age' | 'risk'
export type PatientSortOrder = 'asc' | 'desc'

/**
 * Whole-years age of a patient on `now`, using the project's single age
 * calculation (lib/age.ts::calculateAge — UTC calendar comparison, the same
 * rule the frontend's calcAge() applies to what the row displays, so the
 * order a doctor sees always agrees with the numbers on screen).
 * Returns null for a missing / invalid / future birth date.
 */
export function patientAgeOn(birthDate: Date | null | undefined, now: Date): number | null {
  if (!(birthDate instanceof Date) || Number.isNaN(birthDate.getTime())) return null
  const age = calculateAge(birthDate, now)
  return Number.isFinite(age) && age >= 0 ? age : null
}

/** Decimal(5,4) 0..1 score (Prisma.Decimal | string | number) → finite number, else null. */
export function riskScoreValue(score: unknown): number | null {
  if (score === null || score === undefined) return null
  const n = typeof score === 'number' ? score : Number(String(score))
  return Number.isFinite(n) ? n : null
}

/**
 * Orders `baseOrderIds` (already in the deterministic default order:
 * latest clinical time DESC, created_at DESC, id) by a numeric key.
 *  - numeric comparison only (never string / category);
 *  - `asc` / `desc` flip ONLY the numeric comparison — entries with NO key
 *    (missing age / no current prediction) are ALWAYS last, in both
 *    directions;
 *  - ties (equal key, or both missing) keep the default clinical order, so
 *    the result is deterministic and pagination is stable across requests.
 */
export function orderIdsByNumericKey(
  baseOrderIds: string[],
  keyOf: (id: string) => number | null,
  direction: PatientSortOrder,
): string[] {
  const sign = direction === 'asc' ? 1 : -1
  const rank = new Map(baseOrderIds.map((id, i) => [id, i]))
  return [...baseOrderIds].sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    if (ka === null && kb === null) return rank.get(a)! - rank.get(b)!
    if (ka === null) return 1
    if (kb === null) return -1
    if (ka !== kb) return (ka - kb) * sign
    return rank.get(a)! - rank.get(b)!
  })
}
