/**
 * Typed provider error for deterministic failure classification.
 *
 * Replaces the previous single-code DomainError('PAYMENT_PROVIDER_UNAVAILABLE')
 * with a taxonomy that supports retryable/permanent/ambiguous classification.
 *
 * The `ambiguous` flag is true when a network timeout occurs during a
 * state-changing operation — the provider may or may not have processed
 * the request. The system must retry with an idempotency key or resolve
 * via reconciliation.
 */

export type ProviderErrorCode =
  | 'PROVIDER_CARD_DECLINED'
  | 'PROVIDER_INVALID_REQUEST'
  | 'PROVIDER_AUTHENTICATION_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_NETWORK_TIMEOUT'
  | 'PROVIDER_RESOURCE_NOT_FOUND'
  | 'PROVIDER_IDEMPOTENCY_CONFLICT'
  | 'PROVIDER_UNKNOWN';

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NETWORK_TIMEOUT',
  'PROVIDER_UNKNOWN',
]);

const AMBIGUOUS_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'PROVIDER_NETWORK_TIMEOUT',
]);

export class ProviderError extends Error {
  name = 'ProviderError' as const;
  readonly code: ProviderErrorCode;
  readonly isStateChanging: boolean;
  readonly stripeErrorType?: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(params: {
    message: string;
    code: ProviderErrorCode;
    isStateChanging: boolean;
    stripeErrorType?: string;
  }) {
    super(params.message);
    this.code = params.code;
    this.isStateChanging = params.isStateChanging;
    this.stripeErrorType = params.stripeErrorType;
    this.retryable = RETRYABLE_CODES.has(params.code);
    this.ambiguous = AMBIGUOUS_CODES.has(params.code) && params.isStateChanging;

    Object.setPrototypeOf(this, ProviderError.prototype);
  }
}
