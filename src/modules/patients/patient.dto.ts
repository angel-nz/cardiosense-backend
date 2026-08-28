import { z } from 'zod'

export const CreatePatientDto = z.object({
  firstName: z.string().min(1).max(100),
  lastName:  z.string().min(1).max(100),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format: YYYY-MM-DD'),
  sex:       z.number().int().min(0).max(1),
  curp:      z.string().length(18).optional(),
  phone:     z.string().max(20).optional(),
})

export const UpdatePatientDto = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName:  z.string().min(1).max(100).optional(),
  phone:     z.string().max(20).optional(),
  isActive:  z.boolean().optional(),
})

export const PatientQueryDto = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  risk:   z.enum(['LOW', 'MODERATE', 'HIGH']).optional(),
})

export const PatientParamDto = z.object({
  id: z.string().uuid('Invalid patient id'),
})

export type CreatePatientDtoType = z.infer<typeof CreatePatientDto>
export type UpdatePatientDtoType = z.infer<typeof UpdatePatientDto>
export type PatientQueryDtoType  = z.infer<typeof PatientQueryDto>
