import { z } from 'zod'

export const RegisterDto = z.object({
  email: z.string().email('Invalid email'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[0-9]/, 'Must contain a number'),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  role: z.enum(['MEDICO', 'ADMIN']).default('MEDICO'),
  // Doctor extra fields
  cedulaProfesional: z.string().optional(),
  especialidad: z.string().optional(),
  hospital: z.string().optional(),
})

export const LoginDto = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const RefreshDto = z.object({
  refreshToken: z.string().min(1),
})

export type RegisterDtoType = z.infer<typeof RegisterDto>
export type LoginDtoType    = z.infer<typeof LoginDto>
export type RefreshDtoType  = z.infer<typeof RefreshDto>
