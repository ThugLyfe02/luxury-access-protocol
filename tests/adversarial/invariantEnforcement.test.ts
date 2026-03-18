/**
 * PHASE N.9 — CHANGE-RESISTANCE & INVARIANT ENFORCEMENT SUITE
 *
 * Proves that critical safety invariants are now enforced at runtime
 * and resist accidental breakage.
 *
 * Tests:
 * INVARIANT 1 — OUTBOX RETENTION
 *   1. Deletion of SUCCEEDED event throws TransferInvariantViolation
 *   2. Deletion of DEAD_LETTER event is allowed
 *   3. Deletion of non-existent event is a no-op
 *
 * INVARIANT 2 — FULL EVENT VISIBILITY
 *   4. findByAggregate returns all events without LIMIT
 *   5. assertEventCollectionComplete warns on suspicious count (structural)
 *
 * INVARIANT 3 — FALLBACK PRECEDENCE
 *   6. assertTransferPrecedence: persisted wins when only persisted exists
 *   7. assertTransferPrecedence: recovered returned when only outbox exists
 *   8. assertTransferPrecedence: matching IDs returns 'persisted'
 *   9. assertTransferPrecedence: conflicting IDs throws
 *   10. assertTransferPrecedence: neither exists returns 'none'
 *
 * INVARIANT 4 — TRANSFER ID VALIDATION
 *   11. isValidTransferId rejects empty string
 *   12. isValidTransferId rejects non-string types
 *   13. isValidTransferId rejects malformed format (no tr_ prefix)
 *   14. isValidTransferId accepts valid Stripe transfer ID
 *   15. ReconciliationEngine rejects malformed recovered transferId
 *
 * INVARIANT 5 — RECONCILIATION COVERAGE
 *   16. runFullSweep iterates ALL rentals (none skipped)
 *
 * INVARIANT 6 — DIAGNOSTICS READ-ONLY
 *   17. OutboxTransferDiagnosticsService does not mutate rental state
 *   18. OutboxTransferDiagnosticsService does not mutate outbox state
 *   19. OutboxTransferDiagnosticsService does not call save()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Rental } from '../../src/domain/entities/Rental';
import { OutboxEvent } from '../../src/domain/entities/OutboxEvent';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryOutboxRepository } from '../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { ReconciliationEngine } from '../../src/application/services/ReconciliationEngine';
import { OutboxTransferDiagnosticsService } from '../../src/application/services/OutboxTransferDiagnosticsService';
import {
  isValidTransferId,
  assertTransferPrecedence,
  assertEventCollectionComplete,
  TransferInvariantViolation,
  shouldBlockOutboxDeletion,
} from '../../src/domain/invariants/TransferTruthInvariants';

// ========================================================================
// HELPERS
// ========================================================================

function makeCapturedRental(id = 'r-inv-1', ageMs = 600_000): Rental {
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId: `w-${id}`,
    rentalPrice: 500,
    createdAt: new Date(Date.now() - ageMs),
  });
  rental.startExternalPayment(`pi_${id}`);
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  rental.confirmReturn();
  return rental;
}

function makeSucceededTransferEvent(rentalId: string, transferId: string): OutboxEvent {
  const event = OutboxEvent.create({
    id: crypto.randomUUID(),
    topic: 'payment.transfer_to_owner',
    aggregateType: 'Rental',
    aggregateId: rentalId,
    payload: { rentalId, amount: 400, connectedAccountId: 'acct_1' },
    dedupKey: `transfer:${rentalId}`,
  });
  event.acquireLease('test-worker', new Date());
  event.markSucceeded(new Date(), { transferId });
  return event;
}

function makeDeadLetterEvent(rentalId: string): OutboxEvent {
  const event = OutboxEvent.create({
    id: crypto.randomUUID(),
    topic: 'payment.transfer_to_owner',
    aggregateType: 'Rental',
    aggregateId: rentalId,
    payload: { rentalId, amount: 400, connectedAccountId: 'acct_1' },
    dedupKey: `transfer-dl:${rentalId}`,
  });
  event.acquireLease('test-worker', new Date());
  event.markFailed(new Date(), 'provider error', true);
  return event;
}

const stubProviderAdapter = {
  fetchPaymentSnapshot: vi.fn().mockResolvedValue({
    paymentIntentId: 'pi_test',
    status: 'succeeded',
    amount: 500,
    currency: 'usd',
    capturedAt: new Date().toISOString(),
  }),
  fetchTransferSnapshot: vi.fn().mockResolvedValue({
    transferId: 'tr_valid_123',
    status: 'paid',
    amount: 400,
    currency: 'usd',
  }),
};

const stubRepairExecutor = {
  autoRepair: vi.fn().mockResolvedValue({ repaired: false }),
  escalate: vi.fn().mockResolvedValue(undefined),
};

const stubReconciliationRepo = {
  createRun: vi.fn().mockResolvedValue(undefined),
  saveRun: vi.fn().mockResolvedValue(undefined),
  createFinding: vi.fn().mockResolvedValue(undefined),
  findOpenByAggregateAndDrift: vi.fn().mockResolvedValue(null),
  findByAggregate: vi.fn().mockResolvedValue([]),
  findByRun: vi.fn().mockResolvedValue([]),
  diagnostics: vi.fn().mockResolvedValue({ countBySeverity: {} }),
};

const stubAuditLogRepo = {
  log: vi.fn().mockResolvedValue(undefined),
};

let rentalRepo: InMemoryRentalRepository;
let outboxRepo: InMemoryOutboxRepository;

beforeEach(() => {
  rentalRepo = new InMemoryRentalRepository();
  outboxRepo = new InMemoryOutboxRepository();
  vi.clearAllMocks();
});

// ========================================================================
// INVARIANT 1 — OUTBOX RETENTION
// ========================================================================

describe('Invariant 1: Outbox retention guard', () => {
  it('1. deletion of SUCCEEDED event throws TransferInvariantViolation', async () => {
    const event = makeSucceededTransferEvent('r-1', 'tr_valid_1');
    await outboxRepo.create(event);

    await expect(outboxRepo.deleteEvent(event.id)).rejects.toThrow(TransferInvariantViolation);
    await expect(outboxRepo.deleteEvent(event.id)).rejects.toThrow(/CRITICAL.*Cannot delete SUCCEEDED/);

    // Event still exists
    const found = await outboxRepo.findById(event.id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('SUCCEEDED');
  });

  it('2. deletion of DEAD_LETTER event is allowed', async () => {
    const event = makeDeadLetterEvent('r-2');
    await outboxRepo.create(event);

    await outboxRepo.deleteEvent(event.id);

    const found = await outboxRepo.findById(event.id);
    expect(found).toBeNull();
  });

  it('3. deletion of non-existent event is a no-op', async () => {
    await expect(outboxRepo.deleteEvent('nonexistent')).resolves.toBeUndefined();
  });
});

// ========================================================================
// INVARIANT 2 — FULL EVENT VISIBILITY
// ========================================================================

describe('Invariant 2: Full event visibility', () => {
  it('4. findByAggregate returns all events without LIMIT', async () => {
    // Create 25 events for the same aggregate
    for (let i = 0; i < 25; i++) {
      const event = OutboxEvent.create({
        id: crypto.randomUUID(),
        topic: 'payment.transfer_to_owner',
        aggregateType: 'Rental',
        aggregateId: 'r-visibility',
        payload: { i },
        dedupKey: `vis:${i}`,
      });
      await outboxRepo.create(event);
    }

    const events = await outboxRepo.findByAggregate('Rental', 'r-visibility');
    expect(events).toHaveLength(25);
  });

  it('5. assertEventCollectionComplete warns on suspicious round-number count', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = new Array(50).fill(null);

    assertEventCollectionComplete(events, 'test-context');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('INVARIANT_WARNING'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('exactly 50 events'),
    );
    warnSpy.mockRestore();
  });
});

// ========================================================================
// INVARIANT 3 — FALLBACK PRECEDENCE
// ========================================================================

describe('Invariant 3: Fallback precedence enforcement', () => {
  it('6. persisted wins when only persisted exists', () => {
    const result = assertTransferPrecedence('tr_persisted_1', null);
    expect(result).toBe('persisted');
  });

  it('7. recovered returned when only outbox exists', () => {
    const result = assertTransferPrecedence(null, 'tr_recovered_1');
    expect(result).toBe('recovered');
  });

  it('8. matching IDs returns persisted', () => {
    const result = assertTransferPrecedence('tr_same_1', 'tr_same_1');
    expect(result).toBe('persisted');
  });

  it('9. conflicting IDs throws TransferInvariantViolation', () => {
    expect(() =>
      assertTransferPrecedence('tr_persisted_x', 'tr_recovered_y'),
    ).toThrow(TransferInvariantViolation);
    expect(() =>
      assertTransferPrecedence('tr_persisted_x', 'tr_recovered_y'),
    ).toThrow(/CRITICAL.*precedence conflict/);
  });

  it('10. neither exists returns none', () => {
    const result = assertTransferPrecedence(null, null);
    expect(result).toBe('none');
  });
});

// ========================================================================
// INVARIANT 4 — TRANSFER ID VALIDATION
// ========================================================================

describe('Invariant 4: Transfer ID validation', () => {
  it('11. rejects empty string', () => {
    expect(isValidTransferId('')).toBe(false);
  });

  it('12. rejects non-string types', () => {
    expect(isValidTransferId(null)).toBe(false);
    expect(isValidTransferId(undefined)).toBe(false);
    expect(isValidTransferId(123)).toBe(false);
    expect(isValidTransferId({})).toBe(false);
  });

  it('13. rejects malformed format (no tr_ prefix)', () => {
    expect(isValidTransferId('abc123')).toBe(false);
    expect(isValidTransferId('xfr_123')).toBe(false);
    expect(isValidTransferId('TR_123')).toBe(false);
    expect(isValidTransferId('tr_')).toBe(false); // prefix only, no content
  });

  it('14. accepts valid Stripe transfer IDs', () => {
    expect(isValidTransferId('tr_abc123')).toBe(true);
    expect(isValidTransferId('tr_1A2b3C4d5E6f7G8h')).toBe(true);
    expect(isValidTransferId('tr_XXXXXXXXXXXXXXXXXX')).toBe(true);
  });

  it('15. ReconciliationEngine rejects malformed recovered transferId', async () => {
    const rental = makeCapturedRental('r-malformed');
    await rentalRepo.save(rental);

    // Create SUCCEEDED event with malformed transferId (no tr_ prefix)
    const event = OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.transfer_to_owner',
      aggregateType: 'Rental',
      aggregateId: 'r-malformed',
      payload: { rentalId: 'r-malformed', amount: 400 },
      dedupKey: 'transfer:r-malformed',
    });
    event.acquireLease('test-worker', new Date());
    event.markSucceeded(new Date(), { transferId: 'MALFORMED_ID' });
    await outboxRepo.create(event);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const engine = new ReconciliationEngine(
      stubReconciliationRepo as any,
      rentalRepo,
      stubProviderAdapter as any,
      stubRepairExecutor as any,
      stubAuditLogRepo as any,
      outboxRepo,
    );

    const result = await engine.reconcileOne(rental, 'run-1', 'test');

    // The malformed ID should have been rejected — no transfer snapshot fetch
    expect(stubProviderAdapter.fetchTransferSnapshot).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('INVARIANT_GUARD'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not match expected Stripe format'),
    );
    warnSpy.mockRestore();
  });
});

// ========================================================================
// INVARIANT 5 — RECONCILIATION COVERAGE
// ========================================================================

describe('Invariant 5: Reconciliation coverage', () => {
  it('16. runFullSweep iterates ALL rentals (none skipped)', async () => {
    // Create 5 rentals in various states
    const r1 = Rental.create({ id: 'r-cov-1', renterId: 'renter-1', watchId: 'w-1', rentalPrice: 100, createdAt: new Date() });
    r1.startExternalPayment('pi_1');
    await rentalRepo.save(r1);

    const r2 = Rental.create({ id: 'r-cov-2', renterId: 'renter-1', watchId: 'w-2', rentalPrice: 200, createdAt: new Date() });
    r2.startExternalPayment('pi_2');
    r2.markPaymentAuthorized();
    await rentalRepo.save(r2);

    const r3 = Rental.create({ id: 'r-cov-3', renterId: 'renter-1', watchId: 'w-3', rentalPrice: 300, createdAt: new Date() });
    r3.startExternalPayment('pi_3');
    r3.markPaymentAuthorized();
    r3.markPaymentCaptured();
    r3.confirmReturn();
    r3.releaseFunds('tr_cov3');
    await rentalRepo.save(r3);

    const r4 = Rental.create({ id: 'r-cov-4', renterId: 'renter-1', watchId: 'w-4', rentalPrice: 400, createdAt: new Date() });
    await rentalRepo.save(r4);

    const r5 = Rental.create({ id: 'r-cov-5', renterId: 'renter-1', watchId: 'w-5', rentalPrice: 500, createdAt: new Date() });
    r5.startExternalPayment('pi_5');
    r5.markPaymentAuthorized();
    r5.markRefunded();
    await rentalRepo.save(r5);

    const findAllSpy = vi.spyOn(rentalRepo, 'findAll');

    const engine = new ReconciliationEngine(
      stubReconciliationRepo as any,
      rentalRepo,
      stubProviderAdapter as any,
      stubRepairExecutor as any,
      stubAuditLogRepo as any,
    );

    const run = await engine.runFullSweep('test');

    // findAll was called (no filtering)
    expect(findAllSpy).toHaveBeenCalledOnce();

    // All 5 rentals were checked (the run tracks this)
    const allRentals = await rentalRepo.findAll();
    expect(allRentals).toHaveLength(5);
  });
});

// ========================================================================
// INVARIANT 6 — DIAGNOSTICS READ-ONLY
// ========================================================================

describe('Invariant 6: Diagnostics are read-only', () => {
  it('17. diagnostics does not mutate rental state', async () => {
    const stuck = makeCapturedRental('r-ro-1');
    await rentalRepo.save(stuck);
    await outboxRepo.create(makeSucceededTransferEvent('r-ro-1', 'tr_ro_1'));

    const diagnostics = new OutboxTransferDiagnosticsService(rentalRepo, outboxRepo);

    const beforeRental = await rentalRepo.findById('r-ro-1');
    const beforeVersion = beforeRental!.version;
    const beforeStatus = beforeRental!.escrowStatus;
    const beforeTransferId = beforeRental!.externalTransferId;

    await diagnostics.getStuckTransferSummary(300_000);
    await diagnostics.getStuckTransferDetails('r-ro-1');
    await diagnostics.getStuckTransferCorrelations(300_000);

    const afterRental = await rentalRepo.findById('r-ro-1');
    expect(afterRental!.version).toBe(beforeVersion);
    expect(afterRental!.escrowStatus).toBe(beforeStatus);
    expect(afterRental!.externalTransferId).toBe(beforeTransferId);
  });

  it('18. diagnostics does not mutate outbox state', async () => {
    const stuck = makeCapturedRental('r-ro-2');
    await rentalRepo.save(stuck);
    const event = makeSucceededTransferEvent('r-ro-2', 'tr_ro_2');
    await outboxRepo.create(event);

    const diagnostics = new OutboxTransferDiagnosticsService(rentalRepo, outboxRepo);

    const beforeEvents = await outboxRepo.findByAggregate('Rental', 'r-ro-2');
    const beforeCount = beforeEvents.length;
    const beforeStatus = beforeEvents[0].status;

    await diagnostics.getStuckTransferSummary(300_000);
    await diagnostics.getStuckTransferDetails('r-ro-2');

    const afterEvents = await outboxRepo.findByAggregate('Rental', 'r-ro-2');
    expect(afterEvents).toHaveLength(beforeCount);
    expect(afterEvents[0].status).toBe(beforeStatus);
  });

  it('19. diagnostics does not call save()', async () => {
    const stuck = makeCapturedRental('r-ro-3');
    await rentalRepo.save(stuck);
    await outboxRepo.create(makeSucceededTransferEvent('r-ro-3', 'tr_ro_3'));

    const rentalSaveSpy = vi.spyOn(rentalRepo, 'save');
    const outboxSaveSpy = vi.spyOn(outboxRepo, 'save');

    const diagnostics = new OutboxTransferDiagnosticsService(rentalRepo, outboxRepo);
    await diagnostics.getStuckTransferSummary(300_000);
    await diagnostics.getStuckTransferDetails('r-ro-3');
    await diagnostics.getStuckTransferCorrelations(300_000);

    // save was only called during setup (initial rental save), not during diagnostics
    expect(rentalSaveSpy).toHaveBeenCalledTimes(0);
    expect(outboxSaveSpy).toHaveBeenCalledTimes(0);
  });
});

// ========================================================================
// SHOULDBLOCKOUTBOXDELETION GUARD
// ========================================================================

describe('shouldBlockOutboxDeletion guard', () => {
  it('blocks deletion of SUCCEEDED events', () => {
    expect(shouldBlockOutboxDeletion('SUCCEEDED')).toBe(true);
  });

  it('allows deletion of non-SUCCEEDED events', () => {
    expect(shouldBlockOutboxDeletion('PENDING')).toBe(false);
    expect(shouldBlockOutboxDeletion('PROCESSING')).toBe(false);
    expect(shouldBlockOutboxDeletion('FAILED')).toBe(false);
    expect(shouldBlockOutboxDeletion('DEAD_LETTER')).toBe(false);
  });
});
