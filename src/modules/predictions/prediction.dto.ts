import { z } from 'zod'
import { boundaryField } from '@/lib/timezone'

export const CreatePredictionDto = z.object({
  patientId:     z.string().uuid('Invalid patient id'),
  healthRecordId: z.string().uuid().optional(),
})

export const PredictionQueryDto = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

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
  from:      boundaryField('from'),
  to:        boundaryField('to'),
}).refine(
  data => !data.from || !data.to || data.from <= data.to,
  { message: '"from" must not be after "to"', path: ['from'] },
)

export type CreatePredictionDtoType = z.infer<typeof CreatePredictionDto>
export type GlobalPredictionQueryDtoType = z.infer<typeof GlobalPredictionQueryDto>
