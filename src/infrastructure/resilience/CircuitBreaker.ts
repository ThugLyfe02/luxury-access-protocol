/**
 * Circuit breaker for external dependency protection.
 *
 * States:
 * - CLOSED: normal operation, requests pass through
 * - OPEN: dependency declared failed, requests fail-fast
 * - HALF_OPEN: probing to see if dependency recovered
 *
 * Transitions:
 * - CLOSED → OPEN: failure count >= threshold within window
 * - OPEN → HALF_OPEN: after cooldown period
 * - HALF_OPEN → CLOSED: probe succeeds
 * - HALF_OPEN → OPEN: probe fails
 */

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreakerOpenError extends Error {
  readonly breakerName: string;
  readonly openSince: Date;
  readonly cooldownMs: number;

  constructor(name: string, openSince: Date, cooldownMs: number) {
    super(`Circuit breaker '${name}' is OPEN (since ${openSince.toISOString()}). Retry after ${cooldownMs}ms cooldown.`);
    this.name = 'CircuitBreakerOpenError';
    this.breakerName = name;
    this.openSince = openSince;
    this.cooldownMs = cooldownMs;
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

export interface CircuitBreakerConfig {
  readonly name: string;
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxProbes: number;
}

export interface CircuitBreakerDiagnostics {
  readonly name: string;
  readonly state: CircuitBreakerState;
  readonly failureCount: number;
  readonly successCount: number;
  readonly lastFailureAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly openedAt: Date | null;
  readonly totalTrips: number;
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private _state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private halfOpenProbes = 0;
  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private openedAt: Date | null = null;
  private totalTrips = 0;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  get state(): CircuitBreakerState {
    // Check if OPEN should transition to HALF_OPEN
    if (this._state === 'OPEN' && this.openedAt) {
      const elapsed = Date.now() - this.openedAt.getTime();
      if (elapsed >= this.config.resetTimeoutMs) {
        this._state = 'HALF_OPEN';
        this.halfOpenProbes = 0;
      }
    }
    return this._state;
  }

  get name(): string {
    return this.config.name;
  }

  /**
   * Execute a function through the circuit breaker.
   * - CLOSED: execute normally
   * - OPEN: fail fast with CircuitBreakerOpenError
   * - HALF_OPEN: allow limited probes
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state; // triggers OPEN→HALF_OPEN check

    if (currentState === 'OPEN') {
      throw new CircuitBreakerOpenError(
        this.config.name,
        this.openedAt!,
        this.config.resetTimeoutMs,
      );
    }

    if (currentState === 'HALF_OPEN' && this.halfOpenProbes >= this.config.halfOpenMaxProbes) {
      throw new CircuitBreakerOpenError(
        this.config.name,
        this.openedAt!,
        this.config.resetTimeoutMs,
      );
    }

    if (currentState === 'HALF_OPEN') {
      this.halfOpenProbes++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Record a success — may close the breaker from HALF_OPEN */
  private onSuccess(): void {
    this.lastSuccessAt = new Date();
    this.successCount++;

    if (this._state === 'HALF_OPEN') {
      this._state = 'CLOSED';
      this.failureCount = 0;
      this.openedAt = null;
      this.halfOpenProbes = 0;
    }

    // Reset failure count on success in CLOSED state (rolling)
    if (this._state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  /** Record a failure — may open the breaker */
  private onFailure(): void {
    this.lastFailureAt = new Date();
    this.failureCount++;

    if (this._state === 'HALF_OPEN') {
      this.trip();
      return;
    }

    if (this._state === 'CLOSED' && this.failureCount >= this.config.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this._state = 'OPEN';
    this.openedAt = new Date();
    this.totalTrips++;
    this.halfOpenProbes = 0;
  }

  /** Force the breaker open (admin/testing) */
  forceOpen(): void {
    this.trip();
  }

  /** Force the breaker closed (admin/testing) */
  forceClose(): void {
    this._state = 'CLOSED';
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenProbes = 0;
  }

  diagnostics(): CircuitBreakerDiagnostics {
    return {
      name: this.config.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
      totalTrips: this.totalTrips,
    };
  }
}
