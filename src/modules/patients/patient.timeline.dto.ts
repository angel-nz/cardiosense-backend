import { z } from 'zod'
import { boundaryField } from '@/lib/timezone'

// U6.2 — parseBoundary/boundaryField/DATE_ONLY moved to lib/timezone.ts
// (now the single canonical implementation — see that file for the full
// explanation). This file just builds TimelineQueryDto from the shared
// helper, unchanged behavior.

export const TimelineQueryDto = z.object({
  from: boundaryField('from'),
  to:   boundaryField('to'),
}).refine(
  data => !data.from || !data.to || data.from <= data.to,
  { message: '"from" must not be after "to"', path: ['from'] },
)

export type TimelineQueryDtoType = z.infer<typeof TimelineQueryDto>

export const TimelineParamDto = z.object({
  patientId: z.string().uuid('Invalid patient id'),
})
