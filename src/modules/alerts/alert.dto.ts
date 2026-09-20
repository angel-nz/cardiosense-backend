import { z } from 'zod'

export const AlertQueryDto = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  // U7.2-FIX-1 — z.coerce.boolean() was here before this fix. It uses
  // JavaScript's native Boolean(value) semantics, which are wrong for
  // query strings: Boolean("false") is `true`, because any non-empty
  // string is truthy — confirmed by direct execution during diagnosis.
  // This explicit z.enum(...).transform(...) accepts exactly the two
  // lowercase wire literals the frontend actually sends ("true"/"false"),
  // maps them to real booleans, and rejects everything else (1, 0, yes,
  // TRUE, "", etc.) with the existing 400 validation-error behavior —
  // never silently normalized.
  unread:   z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  // U7.2 — server-side search: patient CURP, patient name, or alert
  // message (all three, one OR branch each — see alert.repository.ts).
  // Normalization (trim/whitespace-collapse/tokenization/case) happens in
  // the repository, where the Prisma predicate is actually built.
  search:   z.string().trim().min(1).optional(),
})

export const AlertParamDto = z.object({
  id: z.string().uuid('Invalid alert id'),
})

export type AlertQueryDtoType = z.infer<typeof AlertQueryDto>
