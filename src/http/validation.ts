/**
 * Minimal boundary input validation.
 *
 * These helpers validate raw HTTP input shape BEFORE it reaches
 * domain/application code. They prevent malformed transport data
 * from becoming domain objects.
 *
 * Domain-level semantic validation (e.g., "is this price viable?")
 * remains in the domain layer. This file only checks structural
 * shape and type safety at the HTTP boundary.
 */

export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

export interface ValidationResult<T> {
  readonly valid: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly valid: false;
  readonly errors: ValidationError[];
}

export type Validated<T> = ValidationResult<T> | ValidationFailure;

/**
 * Validate the POST /rentals request body.
 */
export interface InitiateRentalInput {
  readonly renterId: string;
  readonly watchId: string;
  readonly rentalPrice: number;
  readonly city: string;
  readonly zipCode: string;
}

export function validateInitiateRentalBody(
  body: unknown,
): Validated<InitiateRentalInput> {
  const errors: ValidationError[] = [];

  if (body === null || body === undefined || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.renterId !== 'string' || obj.renterId.trim() === '') {
    errors.push({ field: 'renterId', message: 'renterId must be a non-empty string' });
  }

  if (typeof obj.watchId !== 'string' || obj.watchId.trim() === '') {
    errors.push({ field: 'watchId', message: 'watchId must be a non-empty string' });
  }

  if (typeof obj.rentalPrice !== 'number' || !Number.isFinite(obj.rentalPrice) || obj.rentalPrice <= 0) {
    errors.push({ field: 'rentalPrice', message: 'rentalPrice must be a positive finite number' });
  }

  if (typeof obj.city !== 'string' || obj.city.trim() === '') {
    errors.push({ field: 'city', message: 'city must be a non-empty string' });
  }

  if (typeof obj.zipCode !== 'string' || obj.zipCode.trim() === '') {
    errors.push({ field: 'zipCode', message: 'zipCode must be a non-empty string' });
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
    },
  };
}

/**
 * Validate a Stripe webhook event body shape.
 *
 * We verify structural integrity only — the webhook controller
 * is responsible for checking event types against the supported set.
 * Real Stripe signature verification belongs in infrastructure
 * (not reconstructed yet — noted as a known gap).
 */
export interface StripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly object: {
      readonly id: string;
      readonly [key: string]: unknown;
    };
  };
}

export function validateStripeWebhookBody(
  body: unknown,
): Validated<StripeWebhookEvent> {
  const errors: ValidationError[] = [];

  if (body === null || body === undefined || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    errors.push({ field: 'id', message: 'Event id must be a non-empty string' });
  }

  if (typeof obj.type !== 'string' || obj.type.trim() === '') {
    errors.push({ field: 'type', message: 'Event type must be a non-empty string' });
  }

  if (
    obj.data === null ||
    obj.data === undefined ||
    typeof obj.data !== 'object'
  ) {
    errors.push({ field: 'data', message: 'Event data must be an object' });
  } else {
    const data = obj.data as Record<string, unknown>;
    if (
      data.object === null ||
      data.object === undefined ||
      typeof data.object !== 'object'
    ) {
      errors.push({ field: 'data.object', message: 'Event data.object must be an object' });
    } else {
      const innerObj = data.object as Record<string, unknown>;
      if (typeof innerObj.id !== 'string' || innerObj.id.trim() === '') {
        errors.push({ field: 'data.object.id', message: 'Event data.object.id must be a non-empty string' });
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: obj as unknown as StripeWebhookEvent,
  };
}
