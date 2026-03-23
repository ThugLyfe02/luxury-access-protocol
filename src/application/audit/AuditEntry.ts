import { Actor } from '../auth/Actor';

/**
 * Structured audit entry capturing a single decision, state change,
 * or blocked operation within the platform.
 *
 * Every entry answers: what happened, who triggered it, what entity
 * was affected, and what was the outcome. Entries are append-only
 * and immutable once created.
 *
 * Design notes:
 * - beforeState / afterState are opaque string snapshots — the audit
 *   layer does not parse or validate domain state, it just records it.
 * - correlationId links related entries (e.g., all steps of a rental
 *   initiation share the same correlationId).
 * - errorCode captures the DomainErrorCode when an operation is blocked.
 * - externalRef captures external system references (e.g., Stripe event ID).
 */
export interface AuditEntry {
  readonly id: string;
  readonly timestamp: Date;
  readonly actor: Actor;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly outcome: 'success' | 'blocked' | 'error';
  readonly beforeState: string | null;
  readonly afterState: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly correlationId: string | null;
  readonly externalRef: string | null;
}
