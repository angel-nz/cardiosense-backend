import type { Prisma } from '@prisma/client'

// SORT-SEARCH-STICKY-FIX-1 (FIX-3) — the ONE person-search strategy shared
// by every doctor-facing search over Patient rows: the main patient
// directory (GET /patients), the hidden-patient management list
// (GET /patients/visibility/hidden), the global prediction history
// (GET /predictions) and the Alerts search.
//
// Strategy (identical to what U6.2/U7.2 already established for Predictions
// and Alerts, now centralised instead of copied three times and *missing*
// from the two patient lists, which matched the whole raw string against a
// single field and therefore could never find "Juan Pérez"):
//
//   1. Unicode-normalise to NFC (an "é" typed as e + U+0301 — macOS / some
//      mobile keyboards — must equal the precomposed "é" stored in the DB),
//      trim and collapse every run of whitespace (incl. NBSP / tabs) to one
//      space.
//   2. Split into terms. A patient matches when EVERY term is contained
//      (case-insensitive) in firstName OR lastName. Terms may therefore be
//      spread over both fields and may be given in any order:
//        "Juan Pérez"             -> firstName "Juan Carlos", lastName "Pérez López"
//        "María García"           -> "María Fernanda" / "García Torres"
//        "Hernández Ruiz"         -> lastName "Hernández Ruiz"
//        "García María"           -> same patient (order-independent)
//        "Jua Pé"                 -> partial terms
//   3. OR the whole normalised string as a CURP fragment (a CURP has no
//      spaces, so the CURP is never split into terms and a name term is never
//      applied to the CURP column). CURP matching is case-insensitive.
//
// Phone / e-mail are not part of any of these searches (they never were);
// the Alerts-only `message` branch stays at the Alerts call site.
//
// Accent handling: matching is accent-SENSITIVE on purpose-of-record — the
// current architecture is Prisma `contains` over PostgreSQL `text` and the
// `unaccent` extension is not installed (installing it would be a schema /
// extension migration, which this block does not authorise). Case-folding and
// NFC composition ARE handled. Documented limitation: "Jose" does not match
// "José".

export function normalizeSearchText(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim()
}

export function personSearchTerms(raw: string | null | undefined): string[] {
  const normalized = normalizeSearchText(raw)
  return normalized ? normalized.split(' ') : []
}

/**
 * Prisma predicate over a Patient row for a free-text person search, or
 * `undefined` when the search is empty / whitespace-only (⇒ no filtering).
 * Compose it as `{ ...base, OR: where.OR }` / `AND: [..]` — it always
 * returns a self-contained `{ OR: [...] }` object so it never collides with
 * the caller's own keys.
 */
export function personSearchWhere(raw: string | null | undefined): { OR: Prisma.PatientWhereInput[] } | undefined {
  const normalized = normalizeSearchText(raw)
  if (!normalized) return undefined
  const terms = normalized.split(' ')
  return {
    OR: [
      {
        AND: terms.map(term => ({
          OR: [
            { firstName: { contains: term, mode: 'insensitive' as const } },
            { lastName:  { contains: term, mode: 'insensitive' as const } },
          ],
        })),
      },
      { curp: { contains: normalized, mode: 'insensitive' as const } },
    ],
  }
}
