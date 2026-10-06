import { z } from 'zod'

// PRE-T-B — strict object: obsolete/unknown clinical fields are rejected
// rather than silently stripped.
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
  glucose:       z.number().min(30).max(500),
  notes:         z.string().max(1000).optional(),
}).strict()

export const RecordQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export type CreateRecordDtoType = z.infer<typeof CreateRecordDto>

// NEW S2A — HTTP request contract for POST /health-records.
// `CreateRecordDto` above remains the canonical CLINICAL model-input contract
// used by the frozen R evidence builder
// (evidence.builder.ts::isValidModelInput) parses, and REAL clinical time is
// not a model input. The request DTO extends it with:
//   measuredAt — REQUIRED (A4) REAL clinical instant: ONE UTC ISO-8601 string
//     with exactly 3 fractional digits and the literal `Z`
//     (e.g. "2026-10-02T18:30:00.000Z"). Offsets, missing zone, other
//     precisions and non-calendar instants are rejected (400). Converting the
//     clinician's Guadalajara wall time to this instant is the client's job
//     (S2E); the backend never guesses a timezone.
//   clinicalTimeSource — server-assigned only (record.service.ts sets
//     CLINICIAN_ENTERED). Any client-supplied value is rejected (400), never
//     silently stored.
// Bounds that need the patient and the request's `now` (≤ now + 5 min,
// clinical day ≥ birthDate) are enforced in record.service.ts.
export const MEASURED_AT_FORMAT_MESSAGE = 'measuredAt must be a UTC instant like 2026-10-02T18:30:00.000Z'

export const MeasuredAtField = z
  .string({ required_error: 'measuredAt is required' })
  .datetime({ precision: 3, offset: false, message: MEASURED_AT_FORMAT_MESSAGE })
  .refine(v => {
    const d = new Date(v)
    return !isNaN(d.getTime()) && d.toISOString() === v
  }, { message: 'measuredAt is not a valid calendar instant' })
  .transform(v => new Date(v))

export const CreateHealthRecordRequestDto = CreateRecordDto.extend({
  measuredAt:         MeasuredAtField,
  clinicalTimeSource: z.undefined({
    invalid_type_error: 'clinicalTimeSource is assigned by the server and must not be sent',
  }).optional(),
}).strict()

export type CreateHealthRecordRequestDtoType = z.infer<typeof CreateHealthRecordRequestDto>
