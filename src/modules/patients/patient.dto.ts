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
  // U4.2A — extended to accept curp/birthDate/sex (all already existed in
  // Prisma/CreatePatientDto — no migration). curp/phone use
  // .nullable().optional(): omitted means "don't touch this field", `null`
  // means "clear it" (both columns are nullable in Prisma) — an empty
  // string is never sent by the frontend (see EditPatientModal), so this
  // DTO doesn't need to special-case it. birthDate/sex keep the exact same
  // validation strictness CreatePatientDto already uses — no new, stricter
  // policy introduced for Update alone.
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format: YYYY-MM-DD').optional(),
  sex:       z.number().int().min(0).max(1).optional(),
  curp:      z.string().length(18).nullable().optional(),
  phone:     z.string().max(20).nullable().optional(),
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
