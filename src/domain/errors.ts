/** Typed error hierarchy so the API layer can map failures to HTTP codes. */

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'resource not found') {
    super('NOT_FOUND', message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 400);
  }
}

/** A provider callback failed signature / authenticity verification. */
export class SignatureError extends AppError {
  constructor(message = 'signature verification failed') {
    super('SIGNATURE_ERROR', message, 401);
  }
}

/** The order cannot move to the requested state. */
export class InvalidStateError extends AppError {
  constructor(message: string) {
    super('INVALID_STATE', message, 409);
  }
}

/** Paid amount/currency did not match what the order required. */
export class AmountMismatchError extends AppError {
  constructor(message: string) {
    super('AMOUNT_MISMATCH', message, 409);
  }
}

/** An upstream provider (API/chain) returned an error or was unreachable. */
export class ProviderError extends AppError {
  constructor(message: string) {
    super('PROVIDER_ERROR', message, 502);
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super('CONFIG_ERROR', message, 500);
  }
}
