import { z } from 'zod'

export const CreateRecordDto = z.object({
  patientId:     z.string().uuid(),
  // U3.2 — optional (was required): age is now derived authoritatively by
  // the backend from Paciente.birthDate at persistence time
  // (record.service.ts::create) and always overwrites whatever value
  // arrives here. Kept accepting the field (not rejecting it) purely for
  // backward compatibility with any existing caller that still sends it —
  // the value itself is never trusted.
  age:           z.number().int().min(18).max(120).optional(),
  currentSmoker: z.boolean(),
  cigsPerDay:    z.number().int().min(0).max(100).default(0),
  bpMeds:        z.boolean(),
  diabetes:      z.boolean(),
  totChol:       z.number().min(50).max(800),
  sysBP:         z.number().min(60).max(300),
  diaBP:         z.number().min(40).max(200),
  bmi:           z.number().min(10).max(80),
  heartRate:     z.number().int().min(30).max(250),
  glucose:       z.number().min(30).max(500),
  notes:         z.string().max(1000).optional(),
})

export const RecordQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export type CreateRecordDtoType = z.infer<typeof CreateRecordDto>
