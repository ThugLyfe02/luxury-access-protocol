/**
 * Centralized runtime resilience configuration.
 *
 * All timeout, concurrency, breaker, rate-limit, and health thresholds
 * are defined here. Invalid config fails startup — no undefined behavior.
 */

export interface ResilienceConfig {
  // --- Timeouts (ms) ---
  readonly providerCallTimeoutMs: number;
  readonly providerSnapshotTimeoutMs: number;
  readonly dbQueryTimeoutMs: number;
  readonly outboxHandlerTimeoutMs: number;

  // --- Circuit Breaker ---
  readonly breakerFailureThreshold: number;
  readonly breakerResetTimeoutMs: number;
  readonly breakerHalfOpenMaxProbes: number;

  // --- Concurrency / Backpressure ---
  readonly outboxWorkerConcurrency: number;
  readonly outboxWorkerBatchSize: number;
  readonly reconciliationWorkerBatchSize: number;

  // --- Rate Limits (requests per window) ---
  readonly rateLimitWindowMs: number;
  readonly rateLimitRentalInitiation: number;
  readonly rateLimitOwnerOnboarding: number;
  readonly rateLimitAdminRepair: number;

  // --- Health / Readiness Thresholds ---
  readonly outboxBacklogDegradedThreshold: number;
  readonly outboxBacklogNotReadyThreshold: number;
  readonly reconUnresolvedCriticalThreshold: number;
  readonly stuckTransferDegradedThreshold: number;
  readonly stuckTransferNotReadyThreshold: number;
  readonly workerHeartbeatStaleMs: number;

  // --- Retry ---
  readonly maxRetryAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly retryJitterMs: number;
}

const DEFAULT_CONFIG: ResilienceConfig = {
  providerCallTimeoutMs: 15_000,
  providerSnapshotTimeoutMs: 10_000,
  dbQueryTimeoutMs: 10_000,
  outboxHandlerTimeoutMs: 30_000,

  breakerFailureThreshold: 5,
  breakerResetTimeoutMs: 30_000,
  breakerHalfOpenMaxProbes: 1,

  outboxWorkerConcurrency: 5,
  outboxWorkerBatchSize: 10,
  reconciliationWorkerBatchSize: 50,

  rateLimitWindowMs: 60_000,
  rateLimitRentalInitiation: 10,
  rateLimitOwnerOnboarding: 5,
  rateLimitAdminRepair: 20,

  outboxBacklogDegradedThreshold: 100,
  outboxBacklogNotReadyThreshold: 500,
  reconUnresolvedCriticalThreshold: 10,
  stuckTransferDegradedThreshold: 5,
  stuckTransferNotReadyThreshold: 20,
  workerHeartbeatStaleMs: 120_000,

  maxRetryAttempts: 3,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 16_000,
  retryJitterMs: 500,
};

/**
 * Validate and freeze resilience config.
 * Throws on any invalid value — fail fast at startup.
 */
export function loadResilienceConfig(
  overrides?: Partial<ResilienceConfig>,
): Readonly<ResilienceConfig> {
  const config: ResilienceConfig = { ...DEFAULT_CONFIG, ...overrides };

  const errors: string[] = [];

  // Timeouts must be positive
  if (config.providerCallTimeoutMs <= 0) errors.push('providerCallTimeoutMs must be > 0');
  if (config.providerSnapshotTimeoutMs <= 0) errors.push('providerSnapshotTimeoutMs must be > 0');
  if (config.dbQueryTimeoutMs <= 0) errors.push('dbQueryTimeoutMs must be > 0');
  if (config.outboxHandlerTimeoutMs <= 0) errors.push('outboxHandlerTimeoutMs must be > 0');

  // Breaker config
  if (config.breakerFailureThreshold < 1) errors.push('breakerFailureThreshold must be >= 1');
  if (config.breakerResetTimeoutMs <= 0) errors.push('breakerResetTimeoutMs must be > 0');
  if (config.breakerHalfOpenMaxProbes < 1) errors.push('breakerHalfOpenMaxProbes must be >= 1');

  // Concurrency
  if (config.outboxWorkerConcurrency < 1) errors.push('outboxWorkerConcurrency must be >= 1');
  if (config.outboxWorkerBatchSize < 1) errors.push('outboxWorkerBatchSize must be >= 1');
  if (config.reconciliationWorkerBatchSize < 1) errors.push('reconciliationWorkerBatchSize must be >= 1');

  // Rate limits
  if (config.rateLimitWindowMs <= 0) errors.push('rateLimitWindowMs must be > 0');
  if (config.rateLimitRentalInitiation < 1) errors.push('rateLimitRentalInitiation must be >= 1');
  if (config.rateLimitOwnerOnboarding < 1) errors.push('rateLimitOwnerOnboarding must be >= 1');
  if (config.rateLimitAdminRepair < 1) errors.push('rateLimitAdminRepair must be >= 1');

  // Health thresholds
  if (config.outboxBacklogDegradedThreshold < 1) errors.push('outboxBacklogDegradedThreshold must be >= 1');
  if (config.outboxBacklogNotReadyThreshold <= config.outboxBacklogDegradedThreshold) {
    errors.push('outboxBacklogNotReadyThreshold must be > outboxBacklogDegradedThreshold');
  }
  if (config.reconUnresolvedCriticalThreshold < 1) errors.push('reconUnresolvedCriticalThreshold must be >= 1');
  if (config.stuckTransferDegradedThreshold < 1) errors.push('stuckTransferDegradedThreshold must be >= 1');
  if (config.stuckTransferNotReadyThreshold <= config.stuckTransferDegradedThreshold) {
    errors.push('stuckTransferNotReadyThreshold must be > stuckTransferDegradedThreshold');
  }
  if (config.workerHeartbeatStaleMs <= 0) errors.push('workerHeartbeatStaleMs must be > 0');

  // Retry
  if (config.maxRetryAttempts < 0) errors.push('maxRetryAttempts must be >= 0');
  if (config.retryBaseDelayMs <= 0) errors.push('retryBaseDelayMs must be > 0');
  if (config.retryMaxDelayMs < config.retryBaseDelayMs) errors.push('retryMaxDelayMs must be >= retryBaseDelayMs');

  if (errors.length > 0) {
    throw new Error(`Invalid resilience config:\n  ${errors.join('\n  ')}`);
  }

  return Object.freeze(config);
}
