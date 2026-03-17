/**
 * HTTP boundary request validation.
 *
 * Validates structural shape and type safety at the edge.
 * Domain-level semantic validation stays in the domain layer.
 */

export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

export interface ValidationSuccess<T> {
  readonly valid: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly valid: false;
  readonly errors: ValidationError[];
}

export type Validated<T> = ValidationSuccess<T> | ValidationFailure;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZIP_PATTERN = /^\d{5}$/;

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// ---------------------------------------------------------------------------
// POST /rentals/initiate
// ---------------------------------------------------------------------------

export interface InitiateRentalDTO {
  readonly renterId: string;
  readonly watchId: string;
  readonly rentalPrice: number;
  readonly city: string;
  readonly zipCode: string;
  readonly idempotencyKey?: string;
}

export function validateInitiateRental(body: unknown): Validated<InitiateRentalDTO> {
  const errors: ValidationError[] = [];

  if (body === null || body === undefined || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  if (!isUUID(obj.renterId)) {
    errors.push({ field: 'renterId', message: 'renterId must be a valid UUID' });
  }

  if (!isUUID(obj.watchId)) {
    errors.push({ field: 'watchId', message: 'watchId must be a valid UUID' });
  }

  if (!isPositiveFiniteNumber(obj.rentalPrice)) {
    errors.push({ field: 'rentalPrice', message: 'rentalPrice must be a positive finite number' });
  }

  if (!isNonEmptyString(obj.city)) {
    errors.push({ field: 'city', message: 'city must be a non-empty string' });
  }

  if (typeof obj.zipCode !== 'string' || !ZIP_PATTERN.test(obj.zipCode.trim())) {
    errors.push({ field: 'zipCode', message: 'zipCode must be exactly 5 numeric digits' });
  }

  if (obj.idempotencyKey !== undefined && !isNonEmptyString(obj.idempotencyKey)) {
    errors.push({ field: 'idempotencyKey', message: 'idempotencyKey must be a non-empty string if provided' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      renterId: (obj.renterId as string).trim(),
      watchId: (obj.watchId as string).trim(),
      rentalPrice: obj.rentalPrice as number,
      city: (obj.city as string).trim(),
      zipCode: (obj.zipCode as string).trim(),
      ...(obj.idempotencyKey !== undefined
        ? { idempotencyKey: (obj.idempotencyKey as string).trim() }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// POST /owners/:ownerId/connected-account
// ---------------------------------------------------------------------------

export interface CreateConnectedAccountDTO {
  readonly ownerId: string;
  readonly email: string;
  readonly country: string;
}

export function validateCreateConnectedAccount(
  params: Record<string, string>,
  body: unknown,
): Validated<CreateConnectedAccountDTO> {
  const errors: ValidationError[] = [];

  if (!isUUID(params.ownerId)) {
    errors.push({ field: 'ownerId', message: 'ownerId path param must be a valid UUID' });
  }

  if (body === null || body === undefined || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  if (!isNonEmptyString(obj.email) || !obj.email.includes('@')) {
    errors.push({ field: 'email', message: 'email must be a valid email address' });
  }

  if (!isNonEmptyString(obj.country) || (obj.country as string).trim().length !== 2) {
    errors.push({ field: 'country', message: 'country must be a 2-letter ISO code' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      ownerId: params.ownerId.trim(),
      email: (obj.email as string).trim(),
      country: (obj.country as string).trim().toUpperCase(),
    },
  };
}

// ---------------------------------------------------------------------------
// POST /owners/:ownerId/onboarding-link
// ---------------------------------------------------------------------------

export interface CreateOnboardingLinkDTO {
  readonly ownerId: string;
  readonly connectedAccountId: string;
  readonly returnUrl: string;
  readonly refreshUrl: string;
}

export function validateCreateOnboardingLink(
  params: Record<string, string>,
  body: unknown,
): Validated<CreateOnboardingLinkDTO> {
  const errors: ValidationError[] = [];

  if (!isUUID(params.ownerId)) {
    errors.push({ field: 'ownerId', message: 'ownerId path param must be a valid UUID' });
  }

  if (body === null || body === undefined || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  if (!isNonEmptyString(obj.connectedAccountId)) {
    errors.push({ field: 'connectedAccountId', message: 'connectedAccountId must be a non-empty string' });
  }

  if (!isNonEmptyString(obj.returnUrl)) {
    errors.push({ field: 'returnUrl', message: 'returnUrl must be a non-empty string' });
  }

  if (!isNonEmptyString(obj.refreshUrl)) {
    errors.push({ field: 'refreshUrl', message: 'refreshUrl must be a non-empty string' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      ownerId: params.ownerId.trim(),
      connectedAccountId: (obj.connectedAccountId as string).trim(),
      returnUrl: (obj.returnUrl as string).trim(),
      refreshUrl: (obj.refreshUrl as string).trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// GET /rentals/:id
// ---------------------------------------------------------------------------

export function validateRentalIdParam(params: Record<string, string>): Validated<{ rentalId: string }> {
  if (!isUUID(params.id)) {
    return { valid: false, errors: [{ field: 'id', message: 'Rental ID must be a valid UUID' }] };
  }
  return { valid: true, value: { rentalId: params.id.trim() } };
}
