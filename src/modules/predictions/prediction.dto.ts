import { z } from 'zod'
import { boundaryField } from '@/lib/timezone'

// NEW S2E-FIX4 — CreatePredictionDto removed together with POST /predictions
// (no public request body can create a Prediction any more).

export const PredictionQueryDto = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// U8.2B — GET /predictions/patient/:patientId query. Previously unvalidated
// (manual `Number(req.query.page) || 1` parsing, same pattern U6.1 found
// and fixed for the global endpoint) — formalized here as part of adding
// `targetId` deep-link resolution (see prediction.repository.ts).
//
// W5.2 — from/to/riskLevel added (additive; page/limit/targetId unchanged).
// riskLevel validation mirrors GlobalPredictionQueryDto's own
// `z.enum(['LOW','MODERATE','HIGH']).optional()` verbatim — one canonical
// enum validation, not a second definition. from/to reuse the same
// boundaryField('from'|'to') helper (lib/timezone.ts) already used by
// GlobalPredictionQueryDto/TimelineQueryDto — same half-open [from, to)
// instant semantics, no new date-parsing logic. The from<=to refine below
// is the identical guard already used on both of those DTOs.
export const PatientPredictionQueryDto = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
  targetId:  z.string().uuid('Invalid target id').optional(),
  riskLevel: z.enum(['LOW', 'MODERATE', 'HIGH']).optional(),
  // NEW S3 — 'clinicalTime' = canonical clinical order (every frontend
  // history). 'predictedAt' (default) keeps the compatible calculation-time
  // order for any non-frontend/technical consumer.
  sortBy:    z.enum(['predictedAt', 'clinicalTime']).default('predictedAt'),
  from:      boundaryField('from'),
  to:        boundaryField('to'),
}).refine(
  data => !data.from || !data.to || data.from <= data.to,
  { message: '"from" must not be after "to"', path: ['from'] },
)

// U6.2 — GET /api/predictions global history. `search` normalization
// (trim/whitespace-collapse/tokenization) happens in the repository, where
// the actual Prisma predicate is built — this DTO only validates shape.
// from/to reuse the shared America/Mexico_City boundaryField (extracted to
// lib/timezone.ts in this same block) — same half-open [from, to) instant
// semantics already used by P2/O2, not a second date convention.
export const GlobalPredictionQueryDto = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
  search:    z.string().trim().min(1).optional(),
  riskLevel: z.enum(['LOW', 'MODERATE', 'HIGH']).optional(),
  sortBy:    z.enum(['predictedAt', 'clinicalTime']).default('predictedAt'),   // NEW S3 — see PatientPredictionQueryDto
  from:      boundaryField('from'),
  to:        boundaryField('to'),
}).refine(
  data => !data.from || !data.to || data.from <= data.to,
  { message: '"from" must not be after "to"', path: ['from'] },
)

export type GlobalPredictionQueryDtoType = z.infer<typeof GlobalPredictionQueryDto>
export type PatientPredictionQueryDtoType = z.infer<typeof PatientPredictionQueryDto>
