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
