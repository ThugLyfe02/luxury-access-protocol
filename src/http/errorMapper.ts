import { Response } from 'express';
import { DomainError } from '../domain/errors/DomainError';
import { DomainErrorCode, isDomainErrorCode } from '../domain/errors/ErrorCodes';

/**
 * Maps domain error codes to HTTP status codes.
 *
 * Bucket rules:
 * - 400 Bad Request: validation failures, invalid input shape
 * - 401 Unauthorized: identity/auth failures
 * - 403 Forbidden: authorization / policy / custody violations
 * - 404 Not Found: entity lookup misses (not mapped here — handled by controllers)
 * - 409 Conflict: state transition violations, escrow/payment FSM conflicts
 * - 422 Unprocessable Entity: business rule rejections (risk, economics, exposure)
 */
const CODE_TO_STATUS: ReadonlyMap<DomainErrorCode, number> = new Map([
  // 400 — Bad Request (malformed input / invalid values)
  ['INVALID_OWNER', 400],
  ['INVALID_VALUATION', 400],
  ['INVALID_EMAIL', 400],
  ['INVALID_NAME', 400],
  ['INVALID_RENTAL_DATES', 400],
  ['INVALID_RENTAL_PARTIES', 400],

  // 401 — Unauthorized (identity)
  ['UNAUTHORIZED', 401],
  ['TOKEN_EXPIRED', 401],
  ['INVALID_CREDENTIALS', 401],
  ['TOO_MANY_ATTEMPTS', 429],

  // 409 — Conflict (state machine / transition violations)
  ['INVALID_STATE_TRANSITION', 409],
  ['INVALID_ESCROW_TRANSITION', 409],
  ['INVALID_PAYMENT_TRANSITION', 409],
  ['VERSION_CONFLICT', 409],
  ['DUPLICATE_REQUEST', 409],
  ['WATCH_UNAVAILABLE', 409],
  ['WATCH_ALREADY_RESERVED', 409],

  // 403 — Forbidden (policy / custody)
  ['CUSTODY_VIOLATION', 403],
  ['RISK_POLICY_VIOLATION', 403],
  ['TIER_ACCESS_DENIED', 403],
  ['CITY_NOT_ACTIVE', 403],

  // 422 — Unprocessable Entity (business rule rejections)
  ['KYC_REQUIRED', 422],
  ['WATCH_NOT_VERIFIED', 422],
  ['CONDITION_REPORT_INVALID', 422],
  ['CUSTODY_EVIDENCE_REQUIRED', 422],
  ['INSURANCE_POLICY_INVALID', 422],
  ['INSURANCE_INACTIVE', 422],
  ['DISPUTE_LOCK', 422],
  ['REVIEW_REQUIRED', 422],
  ['RETURN_NOT_CONFIRMED', 422],
  ['ECONOMICS_NEGATIVE', 422],
  ['PLATFORM_EXPOSURE_LIMIT', 422],
  ['PLATFORM_EXPOSURE_VIOLATION', 422],
  ['RISK_EXCEEDS_CAP', 422],
  ['INVENTORY_BELOW_MINIMUM', 422],

  // 422 — Ledger (business rule, not currently active but mapped for completeness)
  ['INVALID_LEDGER_IMBALANCE', 422],
  ['INVALID_LEDGER_TRANSITION', 422],
  ['INSUFFICIENT_LEDGER_BALANCE', 422],

  // 422 — Risk/fraud signals
  ['HIGH_RISK_TRANSACTION', 422],
  ['SUSPICIOUS_VELOCITY', 422],
  ['COLLUSION_RISK', 422],
  ['ANOMALOUS_TRANSACTION', 422],

  // Payment provider errors
  ['PAYMENT_PROVIDER_UNAVAILABLE', 502],
  ['WEBHOOK_SIGNATURE_INVALID', 401],
  ['CONNECTED_ACCOUNT_MISSING', 422],
  ['DUPLICATE_PAYMENT_EVENT', 409],
  ['RELEASE_NOT_ALLOWED', 409],
  ['REFUND_NOT_ALLOWED', 409],
]);

/**
 * Sends a structured error response for a DomainError.
 * Never exposes stack traces or internal implementation details.
 */
export function sendDomainError(res: Response, error: DomainError): void {
  const status =
    isDomainErrorCode(error.code)
      ? (CODE_TO_STATUS.get(error.code as DomainErrorCode) ?? 500)
      : 500;

  res.status(status).json({
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

/**
 * Catches any error and sends the appropriate HTTP response.
 * DomainErrors get structured responses; everything else gets 500
 * with a generic message (no internal details leaked).
 */
export function sendError(res: Response, error: unknown): void {
  if (error instanceof DomainError) {
    sendDomainError(res, error);
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
