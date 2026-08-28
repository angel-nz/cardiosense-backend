import { z } from 'zod'

export const CreatePredictionDto = z.object({
  patientId:     z.string().uuid('Invalid patient id'),
  healthRecordId: z.string().uuid().optional(),
})

export const PredictionQueryDto = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreatePredictionDtoType = z.infer<typeof CreatePredictionDto>
