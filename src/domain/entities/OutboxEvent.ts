import { DomainError } from '../errors/DomainError';

/**
 * Outbox event status lifecycle:
 *
 * PENDING → PROCESSING → SUCCEEDED (terminal)
 *         → PROCESSING → FAILED → PENDING (retry with backoff)
 *         → PROCESSING → FAILED → DEAD_LETTER (after max attempts, terminal)
 */
export type OutboxEventStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEAD_LETTER';

/**
 * Supported outbox event topics.
 * Each topic maps to exactly one handler in the dispatcher.
 */
export type OutboxEventTopic =
  | 'payment.checkout_session.create'
  | 'payment.capture'
  | 'payment.refund'
  | 'payment.transfer_to_owner'
  | 'payment.connected_account.create'
  | 'payment.onboarding_link.create';

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Durable outbox event entity.
 *
 * Represents an external side effect that must be executed reliably.
 * Created atomically in the same DB transaction as the domain state change.
 * Processed asynchronously by the outbox worker.
 */
export class OutboxEvent {
  readonly id: string;
  readonly topic: OutboxEventTopic;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dedupKey: string;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  private _status: OutboxEventStatus;
  private _attemptCount: number;
  private _availableAt: Date;
  private _lockedAt: Date | null;
  private _lockedBy: string | null;
  private _lastError: string | null;
  private _updatedAt: Date;
  private _result: Readonly<Record<string, unknown>> | null;

  private constructor(params: {
    id: string;
    topic: OutboxEventTopic;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    dedupKey: string;
    status: OutboxEventStatus;
    attemptCount: number;
    maxAttempts: number;
    availableAt: Date;
    lockedAt: Date | null;
    lockedBy: string | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
    result: Record<string, unknown> | null;
  }) {
    this.id = params.id;
    this.topic = params.topic;
    this.aggregateType = params.aggregateType;
    this.aggregateId = params.aggregateId;
    this.payload = Object.freeze({ ...params.payload });
    this.dedupKey = params.dedupKey;
    this._status = params.status;
    this._attemptCount = params.attemptCount;
    this.maxAttempts = params.maxAttempts;
    this._availableAt = params.availableAt;
    this._lockedAt = params.lockedAt;
    this._lockedBy = params.lockedBy;
    this._lastError = params.lastError;
    this.createdAt = params.createdAt;
    this._updatedAt = params.updatedAt;
    this._result = params.result ? Object.freeze({ ...params.result }) : null;
  }

  static create(params: {
    id: string;
    topic: OutboxEventTopic;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    dedupKey: string;
    maxAttempts?: number;
    createdAt?: Date;
  }): OutboxEvent {
    if (!params.id) throw new DomainError('Outbox event ID is required', 'INVALID_STATE_TRANSITION');
    if (!params.topic) throw new DomainError('Outbox event topic is required', 'INVALID_STATE_TRANSITION');
    if (!params.aggregateId) throw new DomainError('Aggregate ID is required', 'INVALID_STATE_TRANSITION');
    if (!params.dedupKey) throw new DomainError('Dedup key is required', 'INVALID_STATE_TRANSITION');

    const now = params.createdAt ?? new Date();
    return new OutboxEvent({
      ...params,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      availableAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      result: null,
    });
  }

  static restore(params: {
    id: string;
    topic: OutboxEventTopic;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    dedupKey: string;
    status: OutboxEventStatus;
    attemptCount: number;
    maxAttempts: number;
    availableAt: Date;
    lockedAt: Date | null;
    lockedBy: string | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
    result: Record<string, unknown> | null;
  }): OutboxEvent {
    return new OutboxEvent(params);
  }

  // --- Getters ---

  get status(): OutboxEventStatus { return this._status; }
  get attemptCount(): number { return this._attemptCount; }
  get availableAt(): Date { return this._availableAt; }
  get lockedAt(): Date | null { return this._lockedAt; }
  get lockedBy(): string | null { return this._lockedBy; }
  get lastError(): string | null { return this._lastError; }
  get updatedAt(): Date { return this._updatedAt; }
  get result(): Readonly<Record<string, unknown>> | null { return this._result; }

  isTerminal(): boolean {
    return this._status === 'SUCCEEDED' || this._status === 'DEAD_LETTER';
  }

  // --- Mutations ---

  /**
   * Acquire a processing lease. Transitions PENDING → PROCESSING.
   */
  acquireLease(workerId: string, now: Date): void {
    if (this._status !== 'PENDING') {
      throw new DomainError(
        `Cannot lease outbox event in ${this._status} status`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = 'PROCESSING';
    this._lockedAt = now;
    this._lockedBy = workerId;
    this._attemptCount += 1;
    this._updatedAt = now;
  }

  /**
   * Mark processing as succeeded. Transitions PROCESSING → SUCCEEDED.
   */
  markSucceeded(now: Date, result?: Record<string, unknown>): void {
    if (this._status !== 'PROCESSING') {
      throw new DomainError(
        `Cannot mark succeeded: event is ${this._status}`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = 'SUCCEEDED';
    this._lockedAt = null;
    this._lockedBy = null;
    this._updatedAt = now;
    if (result) {
      this._result = Object.freeze({ ...result });
    }
  }

  /**
   * Mark processing as failed. Transitions PROCESSING → PENDING (retry)
   * or PROCESSING → DEAD_LETTER (if max attempts exceeded).
   */
  markFailed(now: Date, error: string, permanent: boolean): void {
    if (this._status !== 'PROCESSING') {
      throw new DomainError(
        `Cannot mark failed: event is ${this._status}`,
        'INVALID_STATE_TRANSITION',
      );
    }

    this._lastError = error;
    this._lockedAt = null;
    this._lockedBy = null;
    this._updatedAt = now;

    if (permanent || this._attemptCount >= this.maxAttempts) {
      this._status = 'DEAD_LETTER';
    } else {
      this._status = 'PENDING';
      // Exponential backoff: 2^attempt * 1000ms base
      const backoffMs = Math.pow(2, this._attemptCount) * 1000;
      this._availableAt = new Date(now.getTime() + backoffMs);
    }
  }

  /**
   * Release a stale lease (worker died). PROCESSING → PENDING.
   */
  releaseStaleLease(now: Date): void {
    if (this._status !== 'PROCESSING') {
      throw new DomainError(
        `Cannot release lease: event is ${this._status}`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = 'PENDING';
    this._lockedAt = null;
    this._lockedBy = null;
    this._lastError = 'Lease released: worker timed out';
    this._updatedAt = now;
  }

  /**
   * Admin retry of dead-letter event. DEAD_LETTER → PENDING.
   */
  retryFromDeadLetter(now: Date): void {
    if (this._status !== 'DEAD_LETTER') {
      throw new DomainError(
        `Cannot retry: event is ${this._status}, not DEAD_LETTER`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = 'PENDING';
    this._availableAt = now;
    this._lastError = null;
    this._updatedAt = now;
  }
}
