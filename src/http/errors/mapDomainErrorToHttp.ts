import { DomainError } from '../../domain/errors/DomainError';
import { DomainErrorCode, isDomainErrorCode } from '../../domain/errors/ErrorCodes';

/**
 * Deterministic mapping from DomainErrorCode → HTTP status code.
 *
 * Bucket rules:
 * - 400 Bad Request: malformed input
 * - 401 Unauthorized: identity failures, invalid webhooks
 * - 403 Forbidden: authorization / policy / custody violations
 * - 409 Conflict: state/escrow/payment FSM conflicts, concurrency, duplicates
 * - 422 Unprocessable Entity: business rule rejections
 * - 429 Too Many Attempts: rate limiting
 * - 502 Bad Gateway: external provider failures
 */
const CODE_TO_STATUS: ReadonlyMap<DomainErrorCode, number> = new Map([
  // 400
  ['INVALID_OWNER', 400],
  ['INVALID_VALUATION', 400],
  ['INVALID_EMAIL', 400],
  ['INVALID_NAME', 400],
  ['INVALID_RENTAL_DATES', 400],
  ['INVALID_RENTAL_PARTIES', 400],

  // 401
  ['UNAUTHORIZED', 401],
  ['TOKEN_EXPIRED', 401],
  ['INVALID_CREDENTIALS', 401],
  ['WEBHOOK_SIGNATURE_INVALID', 401],

  // 403
  ['CUSTODY_VIOLATION', 403],
  ['RISK_POLICY_VIOLATION', 403],
  ['TIER_ACCESS_DENIED', 403],
  ['CITY_NOT_ACTIVE', 403],

  // 409
  ['INVALID_STATE_TRANSITION', 409],
  ['INVALID_ESCROW_TRANSITION', 409],
  ['INVALID_PAYMENT_TRANSITION', 409],
  ['VERSION_CONFLICT', 409],
  ['DUPLICATE_REQUEST', 409],
  ['WATCH_UNAVAILABLE', 409],
  ['WATCH_ALREADY_RESERVED', 409],
  ['DUPLICATE_PAYMENT_EVENT', 409],
  ['RELEASE_NOT_ALLOWED', 409],
  ['REFUND_NOT_ALLOWED', 409],

  // 422
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
  ['INVALID_LEDGER_IMBALANCE', 422],
  ['INVALID_LEDGER_TRANSITION', 422],
  ['INSUFFICIENT_LEDGER_BALANCE', 422],
  ['HIGH_RISK_TRANSACTION', 422],
  ['SUSPICIOUS_VELOCITY', 422],
  ['COLLUSION_RISK', 422],
  ['ANOMALOUS_TRANSACTION', 422],
  ['CONNECTED_ACCOUNT_MISSING', 422],

  // 429
  ['TOO_MANY_ATTEMPTS', 429],

  // 502
  ['PAYMENT_PROVIDER_UNAVAILABLE', 502],
]);

/**
 * Resolve HTTP status for a DomainError.
 * Returns 500 for unknown/unmapped codes.
 */
export function mapDomainErrorToStatus(error: DomainError): number {
  if (isDomainErrorCode(error.code)) {
    return CODE_TO_STATUS.get(error.code as DomainErrorCode) ?? 500;
  }
  return 500;
}
