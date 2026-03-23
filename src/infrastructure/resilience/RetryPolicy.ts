/**
 * Explicit retry policy.
 *
 * Rules:
 * - No blanket retries
 * - Only for known transient failure classes
 * - Bounded retry count
 * - Jittered exponential backoff
 * - Idempotency required (caller's responsibility)
 */

import { classifyError, FailureCategory } from './FailureClassification';

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
}

export interface RetryResult<T> {
  readonly success: boolean;
  readonly result?: T;
  readonly attempts: number;
  readonly lastError?: Error;
}

/**
 * Calculate delay with jittered exponential backoff.
 */
export function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  const jitter = Math.floor(Math.random() * config.jitterMs);
  return exponentialDelay + jitter;
}

/**
 * Determine if a failure category is retryable.
 */
export function isRetryable(category: FailureCategory): boolean {
  return category === FailureCategory.DEPENDENCY_TRANSIENT ||
         category === FailureCategory.TIMEOUT;
}

/**
 * Execute a function with bounded retry.
 *
 * Only retries on transient failures (DEPENDENCY_TRANSIENT, TIMEOUT).
 * All other failure categories fail immediately — no wasted retries.
 */
export async function withRetry<T>(
  config: RetryConfig,
  fn: () => Promise<T>,
): Promise<RetryResult<T>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { success: true, result, attempts: attempt + 1 };
    } catch (error) {
      const classified = classifyError(error);
      lastError = error instanceof Error ? error : new Error(String(error));

      // Only retry transient failures
      if (!isRetryable(classified.category)) {
        return { success: false, attempts: attempt + 1, lastError };
      }

      // Don't delay after the last attempt
      if (attempt < config.maxAttempts) {
        const delay = calculateBackoff(attempt, config);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  return { success: false, attempts: config.maxAttempts + 1, lastError };
}
