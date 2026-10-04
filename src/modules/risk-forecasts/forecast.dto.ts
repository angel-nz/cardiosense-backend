import { z } from 'zod'

export const ForecastPatientParamDto = z.object({ patientId: z.string().uuid('Invalid patient id') })

export const ForecastHistoryQueryDto = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})
export type ForecastHistoryQueryDtoType = z.infer<typeof ForecastHistoryQueryDto>
