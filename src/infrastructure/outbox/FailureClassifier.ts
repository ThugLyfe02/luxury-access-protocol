/**
 * Failure classification for outbox event processing.
 *
 * Determines whether a failure is retryable (transient), permanent,
 * or ambiguous (provider may or may not have processed the request).
 *
 * Permanent failures go directly to dead letter — no retry.
 * Retryable failures are retried with exponential backoff.
 * Ambiguous failures are retried with short fixed backoff — the provider
 * may have processed the request, so the retry uses idempotency keys.
 */

import { ProviderError } from '../../domain/errors/ProviderError';

export type FailureKind = 'retryable' | 'permanent' | 'ambiguous';

export interface ClassifiedFailure {
  readonly kind: FailureKind;
  readonly message: string;
}

/**
 * Error codes from the domain/payment layer that indicate permanent failure.
 * These will never succeed on retry — the business state must change first.
 */
const PERMANENT_ERROR_PATTERNS: ReadonlySet<string> = new Set([
  'INVALID_STATE_TRANSITION',
  'INVALID_ESCROW_TRANSITION',
  'INVALID_PAYMENT_TRANSITION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'CONNECTED_ACCOUNT_MISSING',
  'RELEASE_NOT_ALLOWED',
  'REFUND_NOT_ALLOWED',
  'DUPLICATE_REQUEST',
  'DUPLICATE_PAYMENT_EVENT',
  'VERSION_CONFLICT',
]);

/**
 * Substrings in error messages that indicate permanent failure
 * from external providers.
 */
const PERMANENT_MESSAGE_PATTERNS: readonly string[] = [
  'card_declined',
  'expired_card',
  'invalid_account',
  'account_closed',
  'no_such_payment_intent',
  'payment_intent_unexpected_state',
  'charge_already_captured',
  'charge_already_refunded',
];

/**
 * Classify an error as retryable, permanent, or ambiguous.
 *
 * ProviderError is checked first — it carries typed classification
 * from the Stripe error taxonomy. For other errors, the existing
 * domain-code and message-pattern checks apply.
 *
 * Default: retryable. Only errors matching known permanent patterns
 * are classified as permanent. This errs on the side of retry.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  // Typed provider errors carry their own classification
  if (error instanceof ProviderError) {
    if (error.ambiguous) {
      return { kind: 'ambiguous', message: `AMBIGUOUS: ${error.message}` };
    }
    if (error.retryable) {
      return { kind: 'retryable', message: error.message };
    }
    return { kind: 'permanent', message: error.message };
  }

  if (!(error instanceof Error)) {
    return { kind: 'retryable', message: String(error) };
  }

  const message = error.message;
  const code = (error as { code?: string }).code;

  // Check domain error codes
  if (code && PERMANENT_ERROR_PATTERNS.has(code)) {
    return { kind: 'permanent', message };
  }

  // Check provider error message patterns
  const lowerMessage = message.toLowerCase();
  for (const pattern of PERMANENT_MESSAGE_PATTERNS) {
    if (lowerMessage.includes(pattern)) {
      return { kind: 'permanent', message };
    }
  }

  // Default: retryable (network errors, timeouts, 5xx from provider)
  return { kind: 'retryable', message };
}
