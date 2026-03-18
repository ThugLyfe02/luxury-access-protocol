/**
 * Transfer truth invariant enforcement.
 *
 * Encodes the critical safety invariants that the reconciliation and
 * crash-window recovery system depends on. These are compile-time and
 * runtime guards — not business logic.
 *
 * INVARIANT 1: SUCCEEDED outbox events must never be deleted.
 * INVARIANT 2: findByAggregate must return all events (no LIMIT).
 * INVARIANT 3: Rental.externalTransferId always wins over outbox fallback.
 * INVARIANT 4: Recovered transferIds must match Stripe format.
 * INVARIANT 5: Reconciliation full sweep must cover all rentals.
 * INVARIANT 6: Diagnostics services must be read-only.
 */

/**
 * Validate that a transferId matches expected Stripe transfer format.
 *
 * Stripe transfer IDs start with "tr_" followed by alphanumeric chars.
 * This guard prevents synthetic, empty, or malformed IDs from being
 * accepted as truth during outbox recovery.
 *
 * @returns true if the id is a valid Stripe transfer ID
 */
export function isValidTransferId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0) return false;
  return /^tr_[a-zA-Z0-9_]+$/.test(id);
}

/**
 * Assert that a recovered transfer ID and persisted transfer ID do not
 * conflict. If both exist and differ, this is a CRITICAL invariant
 * violation — silent resolution must never occur.
 *
 * @returns 'persisted' if rental has the authoritative ID,
 *          'recovered' if only outbox has it,
 *          'none' if neither has it,
 *          throws if both exist and differ
 */
export function assertTransferPrecedence(
  persistedTransferId: string | null,
  recoveredTransferId: string | null,
): 'persisted' | 'recovered' | 'none' {
  if (persistedTransferId && recoveredTransferId) {
    if (persistedTransferId !== recoveredTransferId) {
      throw new TransferInvariantViolation(
        `CRITICAL: Transfer ID precedence conflict — ` +
        `persisted="${persistedTransferId}" vs recovered="${recoveredTransferId}". ` +
        `This must not be silently resolved.`,
      );
    }
    return 'persisted';
  }
  if (persistedTransferId) return 'persisted';
  if (recoveredTransferId) return 'recovered';
  return 'none';
}

/**
 * Error class for transfer truth invariant violations.
 * These are structural safety failures, not business errors.
 */
export class TransferInvariantViolation extends Error {
  readonly code = 'TRANSFER_INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'TransferInvariantViolation';
  }
}

/**
 * Assert that an event collection was not truncated by a LIMIT.
 * Used as a runtime guard on findByAggregate results.
 *
 * This is a structural assertion: if a known-truncation boundary is
 * detected (e.g., results length exactly equals a suspicious round number),
 * it logs a warning but does not throw — because we cannot distinguish
 * "exactly N events" from "truncated at N" without query metadata.
 *
 * The real enforcement is in the repository implementation: findByAggregate
 * must NOT apply a LIMIT clause.
 */
export function assertEventCollectionComplete(
  events: ReadonlyArray<unknown>,
  context: string,
): void {
  // Suspicious truncation boundaries — if event count exactly matches
  // common LIMIT values, this warrants investigation
  const SUSPICIOUS_LIMITS = [10, 25, 50, 100, 200, 500, 1000];
  if (SUSPICIOUS_LIMITS.includes(events.length)) {
    console.warn(
      `[INVARIANT_WARNING] ${context}: findByAggregate returned exactly ${events.length} events — ` +
      `verify no LIMIT was applied. Transfer truth recovery depends on full event visibility.`,
    );
  }
}

/**
 * Guard against deletion of SUCCEEDED outbox events.
 * Returns true if the deletion should be blocked.
 */
export function shouldBlockOutboxDeletion(eventStatus: string): boolean {
  return eventStatus === 'SUCCEEDED';
}
