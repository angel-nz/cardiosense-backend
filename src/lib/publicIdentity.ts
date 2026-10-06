import type { Role } from '@prisma/client'

export type PublicRole = 'ADMIN' | 'MEDICO' | 'PACIENTE'

export function toPublicRole(role: Role): PublicRole {
  if (role === 'DOCTOR') return 'MEDICO'
  if (role === 'PATIENT') return 'PACIENTE'
  return 'ADMIN'
}

export function registrationRoleToDatabase(role: 'MEDICO' | 'ADMIN'): Role {
  return role === 'MEDICO' ? 'DOCTOR' : 'ADMIN'
}

export interface PublicDoctorProfile {
  id: string
  cedulaProfesional: string | null
  especialidad: string | null
  hospital: string | null
  phone: string | null
}

export function toPublicDoctorProfile(doctor: {
  id: string
  professionalLicense: string | null
  specialty: string | null
  hospital: string | null
  phone: string | null
} | null | undefined): PublicDoctorProfile | undefined {
  if (!doctor) return undefined
  return {
    id: doctor.id,
    cedulaProfesional: doctor.professionalLicense,
    especialidad: doctor.specialty,
    hospital: doctor.hospital,
    phone: doctor.phone,
  }
}
