import { z } from 'zod'

export const AlertQueryDto = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  unread:   z.coerce.boolean().optional(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
})

export const AlertParamDto = z.object({
  id: z.string().uuid('Invalid alert id'),
})

export type AlertQueryDtoType = z.infer<typeof AlertQueryDto>
