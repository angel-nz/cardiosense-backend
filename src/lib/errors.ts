export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number = 500,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'AppError'
    Error.captureStackTrace(this, this.constructor)
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND')
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED')
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN')
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT')
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR')
  }
}

// Y3 — a doctor's cedulaProfesional is unique (Medico.cedulaProfesional).
// The generic Prisma P2002 handler in errorHandler.ts produces code
// 'CONFLICT', but the frontend needs to branch specifically on a duplicate
// cedula (as opposed to any other future unique-constraint conflict), so
// this is caught explicitly in the route and re-thrown as this error.
export class DuplicateCedulaError extends AppError {
  constructor() {
    super('Ya existe un médico registrado con esa cédula profesional.', 409, 'DUPLICATE_CEDULA')
  }
}

// Z6-R1-FIX1 §4/§5 — PATCH /users/me/profile: Medico.phone is now
// `@unique` (Z6-R1 schema change, since it doubled as a login identifier),
// so a second doctor setting their phone to a value another doctor already
// owns is a genuine, distinct conflict — previously mis-reported by this
// route's P2002 handler as DuplicateCedulaError (same catch block, no
// `err.meta?.target` column check). Same shape/precedent as
// DuplicateCedulaError (409, a dedicated code the frontend can branch on),
// never identifying or otherwise leaking which other doctor already owns
// the phone.
export class DuplicatePhoneError extends AppError {
  constructor() {
    super('Este número de teléfono ya está registrado.', 409, 'DUPLICATE_PHONE')
  }
}

// Z8 — PATIENT LIFECYCLE & VISIBILITY MANAGEMENT.
//
// An INACTIVE_VISIBLE patient (isActive=false, isHidden=false) is a real,
// fully resolvable, owned patient — never a 404 — but may not receive new
// clinical activity. Thrown by HealthRecordService.create() and
// PredictionService.predict() for exactly this state, BEFORE any
// HealthRecord insert / any callAIPredict call. A HIDDEN patient never
// reaches this error — the same ownership lookups that would reach this
// check already exclude isHidden=true rows entirely, so a hidden patient's
// new-record/new-prediction attempt surfaces as the normal NotFoundError
// instead (no "this patient exists but is hidden" leak — see Z8 §26).
export class PatientInactiveError extends AppError {
  constructor() {
    super(
      'El paciente está inactivo. Reactívalo para registrar nueva actividad clínica.',
      409,
      'PATIENT_INACTIVE',
    )
  }
}

// Z8 — the visibility endpoint's HIDE direction (PATCH /patients/:id/
// visibility, { isHidden: true }) requires the patient to already be
// INACTIVE (isActive=false) before it may be hidden — hiding an ACTIVE
// patient directly, in one mutation, would silently combine two distinct
// product decisions (deactivate + hide) that Z8 requires to stay separate
// and explicit (the doctor must deactivate first, then hide, as two
// deliberate actions). Never silently deactivates the patient instead of
// rejecting.
export class PatientMustBeInactiveToHideError extends AppError {
  constructor() {
    super(
      'El paciente debe estar inactivo antes de poder ocultarlo.',
      409,
      'PATIENT_MUST_BE_INACTIVE_TO_HIDE',
    )
  }
}

// U8.6B — prediction outcomes that are NOT technical unavailability.
// The current model does not support this record's age (observed model age
// support). Not a statement about the patient, the record, or clinical risk.
export class ModelIneligibleError extends AppError {
  constructor(
    message: string,
    public readonly modelVersion: string,
    public readonly eligibleAgeRange: { min: number; max: number },
  ) {
    super(message, 422, 'MODEL_INELIGIBLE')
  }
}

// The AI service was reachable but rejected the payload as invalid (HTTP 422).
export class AIInputRejectedError extends AppError {
  constructor() {
    super('AI prediction input was rejected by the model service', 422, 'AI_INPUT_REJECTED')
  }
}

// The AI service responded with an unexpected failure (not 422/503).
export class AIServiceError extends AppError {
  constructor() {
    super('AI prediction service failed', 502, 'AI_FAILURE')
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service: string) {
    super(`${service} service unavailable`, 503, 'SERVICE_UNAVAILABLE')
  }
}

// Y8D1 — POST /auth/refresh: the presented refresh credential named a real,
// still-valid session that has already been rotated out from under this
// exact request — typically a losing concurrent refresh from another browser
// tab sharing the same cookie jar (see lib/session.ts's classifyRefreshCredential
// and rotateSession's compare-and-swap). Deliberately NOT the generic
// ConflictError: the frontend needs to branch on this specific code (same
// reasoning as DuplicateCedulaError above) to eventually retry rather than
// treating it as a logout (Y8D4, not yet implemented). Never issued for a
// genuinely dead/foreign/expired session — that remains a plain
// UnauthorizedError, unchanged. The message is fixed and generic; this must
// never carry the stored or presented token hash, jti, sid, or any other
// internal/Prisma detail (Y8D1 §9).
export class RefreshConflictError extends AppError {
  constructor() {
    super('Session refresh conflict', 409, 'REFRESH_CONFLICT')
  }
}

// Y5.1 — PATCH /users/me/password: the supplied currentPassword did not
// match the stored bcrypt hash. 401 (a credential-verification failure, same
// status family as login's UnauthorizedError), but a DISTINCT code —
// INVALID_CURRENT_PASSWORD, never the generic 'UNAUTHORIZED' — specifically
// so the frontend's global 401 interceptor (api.ts) can distinguish "your
// current password was wrong" from "your session/access token is no longer
// valid" and avoid forcing a logout for the former (Y5.1 §8/§9).
export class InvalidCurrentPasswordError extends AppError {
  constructor() {
    super('La contraseña actual es incorrecta.', 401, 'INVALID_CURRENT_PASSWORD')
  }
}

// Y5.1 — PATCH /users/me/password: newPassword === currentPassword, checked
// server-side (defense in depth — the frontend already prevents this
// client-side) only AFTER currentPassword has been verified correct, so this
// never leaks anything about an incorrect guess.
export class PasswordUnchangedError extends AppError {
  constructor() {
    super('La nueva contraseña debe ser diferente de la actual.', 400, 'PASSWORD_UNCHANGED')
  }
}

// Z6-R1 §2/§17 — PATCH /users/me/profile: the caller asked to clear
// Medico.phone (set it to null) while this account's User.email is ALREADY
// null. Phone is this account's only login identifier in that state, so
// clearing it would leave the account with zero ways to authenticate — a
// self-inflicted lockout. 400 (a business-rule validation failure, same
// status family as ValidationError), but its own distinct code so the
// frontend can route this specifically to the phone field rather than a
// generic banner (same reasoning as DuplicateCedulaError/
// InvalidCurrentPasswordError above). Rejected BEFORE any write — no
// partial mutation, no doctor-profile information Alert.
export class PhoneLastIdentifierError extends AppError {
  constructor() {
    super(
      'No puedes eliminar tu teléfono: es tu único método de inicio de sesión. Agrega un correo electrónico primero.',
      400,
      'PHONE_REQUIRED_FOR_LOGIN',
    )
  }
}

// ─── Y3.1B — Profile image (avatar) errors ─────────────────────────────────
// Frozen exactly as specified in Y3.1A-FIX1 §17 / Y3.1B §15. Never leak Sharp
// stack traces, Prisma internals, filesystem paths, or raw multipart bodies
// in any of these messages — every message here is a fixed, generic,
// user-facing string; diagnostic detail (if any) is logged server-side only
// via lib/logger, never returned to the client (Y3.1B §15/§39).

// Multer's own file-size limit error (LIMIT_FILE_SIZE) is caught and
// re-thrown as this — never returned as Multer's raw error shape.
export class FileTooLargeError extends AppError {
  constructor() {
    super('La imagen supera el tamaño máximo permitido (5 MB).', 413, 'FILE_TOO_LARGE')
  }
}

// The declared or actual decoded format is not one of {jpeg, png, webp}.
// Deliberately distinct from ANIMATED_IMAGE_NOT_SUPPORTED below — this is a
// wrong-format rejection, not an accepted-format-but-animated rejection.
export class UnsupportedMediaTypeError extends AppError {
  constructor() {
    super('Formato de imagen no compatible. Usa JPEG, PNG o WebP.', 415, 'UNSUPPORTED_MEDIA_TYPE')
  }
}

// Malformed multipart, or Sharp could not decode the uploaded bytes as an
// image at all (corrupt file, non-image content disguised with an image
// extension/Content-Type). The declared Content-Type is never authoritative
// — only Sharp's actual decode result is (Y3.1A-FIX1 §21/§25, Y3.1B §10/§11).
export class InvalidImageError extends AppError {
  constructor() {
    super('El archivo no pudo procesarse como una imagen válida.', 400, 'INVALID_IMAGE')
  }
}

// Decoded pixel width × height exceeds the configured ceiling — a
// decompression-bomb guard (a small compressed file can still decode to an
// enormous pixel grid). Checked from decoded metadata BEFORE any resize is
// attempted (Y3.1B §12).
export class ImageDimensionsExceededError extends AppError {
  constructor() {
    super('Las dimensiones de la imagen exceden el máximo permitido.', 400, 'IMAGE_DIMENSIONS_EXCEEDED')
  }
}

// Animated WebP or multi-page/APNG PNG — the format itself is accepted, only
// the animated/multi-frame variant is rejected, so this is a dedicated code
// distinct from UNSUPPORTED_MEDIA_TYPE (Y3.1A-FIX1 §20, Y3.1B §10/§39).
export class AnimatedImageNotSupportedError extends AppError {
  constructor() {
    super('No se admiten imágenes animadas o de múltiples cuadros.', 400, 'ANIMATED_IMAGE_NOT_SUPPORTED')
  }
}

// The bounded 82→76→70 WebP quality ladder still could not bring the
// normalized 512×512 output under the 300 KB ceiling. 422 (not 500): the
// upload itself was a valid, well-formed image — this is a semantic
// rejection of that specific image's compressibility, not a server fault
// (Y3.1B §14 — explicitly replaces Y3.1A-FIX1's earlier placeholder 500).
export class ImageOutputTooLargeError extends AppError {
  constructor() {
    super('No fue posible comprimir la imagen por debajo del límite permitido.', 422, 'IMAGE_OUTPUT_TOO_LARGE')
  }
}

// The normalization/encode pipeline itself threw unexpectedly AFTER all
// validation steps already passed — i.e. a genuine server-side fault, not a
// rejection of the input. Never carries the underlying Sharp error's own
// message/stack.
export class AvatarProcessingFailedError extends AppError {
  constructor() {
    super('No se pudo procesar la imagen. Intenta de nuevo.', 500, 'PROCESSING_FAILED')
  }
}

// The image passed validation and normalization but the database write
// (AvatarImage upsert) itself failed. Distinct from a generic 500 so the
// frontend/ops can tell "your image was fine, we couldn't save it right
// now" apart from a processing fault (Y3.1A-FIX1 §17, Y3.1B §15/§21).
export class AvatarStorageUnavailableError extends AppError {
  constructor() {
    super('No se pudo guardar la imagen en este momento. Intenta de nuevo más tarde.', 503, 'STORAGE_UNAVAILABLE')
  }
}

// GET /users/me/avatar — no AvatarImage row exists for this user. A normal,
// expected steady state (most users have no avatar), not a fault.
export class NoAvatarError extends AppError {
  constructor() {
    super('Este usuario no tiene una imagen de perfil.', 404, 'NO_AVATAR')
  }
}
