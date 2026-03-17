/**
 * Runtime failure classification.
 *
 * Every error flowing through the system is classified into one of these
 * categories. This drives retry eligibility, circuit breaker counting,
 * HTTP status mapping, log level, and alert severity.
 */

export enum FailureCategory {
  /** Bad input from client */
  CLIENT_VALIDATION = 'CLIENT_VALIDATION',
  /** Auth/authz failure */
  AUTH = 'AUTH',
  /** Domain invariant violation — business logic hard stop */
  DOMAIN_HARD_STOP = 'DOMAIN_HARD_STOP',
  /** External dependency transient failure (network, timeout, 5xx) */
  DEPENDENCY_TRANSIENT = 'DEPENDENCY_TRANSIENT',
  /** External dependency permanent failure (invalid resource, rejected) */
  DEPENDENCY_TERMINAL = 'DEPENDENCY_TERMINAL',
  /** Infrastructure overload (pool exhausted, backpressure) */
  INFRASTRUCTURE_OVERLOAD = 'INFRASTRUCTURE_OVERLOAD',
  /** Operation timed out or was cancelled */
  TIMEOUT = 'TIMEOUT',
  /** Unknown / unexpected error */
  INTERNAL_UNEXPECTED = 'INTERNAL_UNEXPECTED',
}

export interface ClassifiedError {
  readonly category: FailureCategory;
  readonly retryable: boolean;
  readonly circuitBreakerCountable: boolean;
  readonly httpStatus: number;
  readonly logLevel: 'warn' | 'error';
  readonly alertSeverity: 'none' | 'low' | 'high' | 'critical';
  readonly message: string;
  readonly originalError?: Error;
}

/** Domain error codes that indicate client/validation issues */
const CLIENT_CODES = new Set([
  'INVALID_OWNER', 'INVALID_VALUATION', 'INVALID_EMAIL', 'INVALID_NAME',
  'INVALID_RENTAL_DATES', 'INVALID_RENTAL_PARTIES',
]);

/** Domain error codes that indicate auth issues */
const AUTH_CODES = new Set([
  'UNAUTHORIZED', 'TOKEN_EXPIRED', 'INVALID_CREDENTIALS',
  'WEBHOOK_SIGNATURE_INVALID', 'FORBIDDEN', 'UNAUTHORIZED_ADMIN_ACTION',
]);

/** Domain error codes that are domain hard-stops */
const DOMAIN_CODES = new Set([
  'INVALID_STATE_TRANSITION', 'VERSION_CONFLICT', 'DUPLICATE_REQUEST',
  'WATCH_UNAVAILABLE', 'WATCH_ALREADY_RESERVED', 'INVALID_ESCROW_TRANSITION',
  'INVALID_PAYMENT_TRANSITION', 'DUPLICATE_PAYMENT_EVENT', 'RELEASE_NOT_ALLOWED',
  'REFUND_NOT_ALLOWED', 'KYC_REQUIRED', 'REVIEW_REQUIRED', 'FROZEN_ENTITY',
  'MANUAL_REVIEW_REQUIRED', 'ECONOMICS_NEGATIVE', 'PLATFORM_EXPOSURE_LIMIT',
  'RISK_POLICY_VIOLATION', 'CUSTODY_VIOLATION', 'DISPUTE_LOCK',
  'CONNECTED_ACCOUNT_MISSING', 'INSURANCE_INACTIVE', 'RETURN_NOT_CONFIRMED',
]);

/** Message patterns indicating provider transient failure */
const TRANSIENT_PATTERNS = [
  'network', 'econnrefused', 'econnreset', 'etimedout', 'socket hang up',
  'rate limit', 'too many requests', '503', '502', '429',
];

/** Message patterns indicating timeout */
const TIMEOUT_PATTERNS = ['timeout', 'timed out', 'aborted', 'deadline exceeded'];

/**
 * Classify any error into a failure category with consistent metadata.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (!(error instanceof Error)) {
    return {
      category: FailureCategory.INTERNAL_UNEXPECTED,
      retryable: false,
      circuitBreakerCountable: false,
      httpStatus: 500,
      logLevel: 'error',
      alertSeverity: 'high',
      message: String(error),
    };
  }

  const code = (error as { code?: string }).code;
  const message = error.message;
  const lowerMessage = message.toLowerCase();

  // 1. Client validation
  if (code && CLIENT_CODES.has(code)) {
    return {
      category: FailureCategory.CLIENT_VALIDATION,
      retryable: false,
      circuitBreakerCountable: false,
      httpStatus: 400,
      logLevel: 'warn',
      alertSeverity: 'none',
      message,
      originalError: error,
    };
  }

  // 2. Auth/authz
  if (code && AUTH_CODES.has(code)) {
    return {
      category: FailureCategory.AUTH,
      retryable: false,
      circuitBreakerCountable: false,
      httpStatus: 401,
      logLevel: 'warn',
      alertSeverity: 'none',
      message,
      originalError: error,
    };
  }

  // 3. Domain hard-stop
  if (code && DOMAIN_CODES.has(code)) {
    return {
      category: FailureCategory.DOMAIN_HARD_STOP,
      retryable: false,
      circuitBreakerCountable: false,
      httpStatus: 409,
      logLevel: 'warn',
      alertSeverity: 'none',
      message,
      originalError: error,
    };
  }

  // 4. Timeout
  if (TIMEOUT_PATTERNS.some(p => lowerMessage.includes(p)) || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return {
      category: FailureCategory.TIMEOUT,
      retryable: true,
      circuitBreakerCountable: true,
      httpStatus: 504,
      logLevel: 'error',
      alertSeverity: 'high',
      message,
      originalError: error,
    };
  }

  // 5. Dependency transient (network, rate limit, 5xx)
  if (TRANSIENT_PATTERNS.some(p => lowerMessage.includes(p))) {
    return {
      category: FailureCategory.DEPENDENCY_TRANSIENT,
      retryable: true,
      circuitBreakerCountable: true,
      httpStatus: 502,
      logLevel: 'error',
      alertSeverity: 'high',
      message,
      originalError: error,
    };
  }

  // 6. Provider terminal (known permanent patterns from FailureClassifier)
  if (code === 'PAYMENT_PROVIDER_UNAVAILABLE') {
    return {
      category: FailureCategory.DEPENDENCY_TRANSIENT,
      retryable: true,
      circuitBreakerCountable: true,
      httpStatus: 502,
      logLevel: 'error',
      alertSeverity: 'high',
      message,
      originalError: error,
    };
  }

  // 7. Default: internal unexpected
  return {
    category: FailureCategory.INTERNAL_UNEXPECTED,
    retryable: false,
    circuitBreakerCountable: false,
    httpStatus: 500,
    logLevel: 'error',
    alertSeverity: 'high',
    message,
    originalError: error,
  };
}
