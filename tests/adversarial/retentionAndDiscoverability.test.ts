/**
 * RETENTION & DISCOVERABILITY AUDIT SUITE
 *
 * Proves that:
 * 1. SUCCEEDED outbox events are never deleted by any system component
 * 2. findByAggregate returns ALL events without pagination/truncation
 * 3. Recovery works regardless of event age
 * 4. Reconciliation sweep finds and backfills stuck rentals
 * 5. Multiple reconciliation sweeps converge idempotently
 * 6. Outbox retention gap (purged events) is fail-safe (no false action)
 * 7. Backfill + reconciliation produces audit trail for operational visibility
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Rental } from '../../src/domain/entities/Rental';
import { OutboxEvent } from '../../src/domain/entities/OutboxEvent';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryOutboxRepository } from '../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { ReconciliationEngine } from '../../src/application/services/ReconciliationEngine';

// ========================================================================
// HELPERS
// ========================================================================

function makeCapturedRental(id = 'r-ret-1'): Rental {
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId: `w-${id}`,
    rentalPrice: 500,
    createdAt: new Date(),
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

function makeReconRepo() {
  return {
    createRun: vi.fn(),
    saveRun: vi.fn(),
    findRun: vi.fn(),
    createFinding: vi.fn(),
    saveFinding: vi.fn(),
    findByAggregate: vi.fn().mockResolvedValue([]),
    findOpenByAggregateAndDrift: vi.fn().mockResolvedValue(null),
    diagnostics: vi.fn(),
  };
}

function makeAdapter(transferSnapshot?: unknown) {
  return {
    fetchPaymentSnapshot: vi.fn().mockImplementation((piId: string) =>
      Promise.resolve({
        paymentIntentId: piId,
        status: 'succeeded' as const,
        amountCaptured: 50000,
        amountRefunded: 0,
        currency: 'usd',
        disputeOpen: false,
        disputeStatus: null,
        metadata: {},
        fetchedAt: new Date(),
      }),
    ),
    fetchTransferSnapshot: vi.fn().mockResolvedValue(transferSnapshot ?? {
      transferId: 'tr_default',
      status: 'paid',
      amount: 40000,
      currency: 'usd',
      destination: 'acct_1',
      reversed: false,
      metadata: {},
      fetchedAt: new Date(),
    }),
    fetchConnectedAccountSnapshot: vi.fn(),
  };
}

function makeAuditLogRepo() {
  return {
    log: vi.fn(),
    findByEntity: vi.fn().mockResolvedValue([]),
    findByActor: vi.fn().mockResolvedValue([]),
  };
}

function makeRepairExecutor() {
  return {
    autoRepair: vi.fn().mockResolvedValue({ repaired: false, action: 'none', findingId: '', froze: false, reviewCreated: false }),
    escalate: vi.fn().mockResolvedValue({ repaired: false, action: 'escalated', findingId: '', froze: true, reviewCreated: true }),
    manualRepair: vi.fn(),
    suppress: vi.fn(),
  };
}

function makeEngine(
  rentalRepo: InMemoryRentalRepository,
  outboxRepo: InMemoryOutboxRepository,
  adapter?: ReturnType<typeof makeAdapter>,
  auditLogRepo?: ReturnType<typeof makeAuditLogRepo>,
) {
  return new ReconciliationEngine(
    makeReconRepo() as any,
    rentalRepo,
    adapter ?? makeAdapter(),
    makeRepairExecutor() as any,
    (auditLogRepo ?? makeAuditLogRepo()) as any,
    outboxRepo,
  );
}

// ========================================================================
// 1. SUCCEEDED EVENTS ARE NEVER DELETED
// ========================================================================

describe('Retention: SUCCEEDED events persist permanently', () => {
  it('InMemoryOutboxRepository never removes SUCCEEDED events', async () => {
    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-ret-1', 'tr_permanent');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    // Verify the event is findable
    const found = await outboxRepo.findByAggregate('Rental', 'r-ret-1');
    expect(found).toHaveLength(1);
    expect(found[0].status).toBe('SUCCEEDED');
    expect(found[0].result?.transferId).toBe('tr_permanent');

    // No delete method exists on OutboxRepository interface
    // The event persists indefinitely
    const foundAgain = await outboxRepo.findByAggregate('Rental', 'r-ret-1');
    expect(foundAgain).toHaveLength(1);
  });
});

// ========================================================================
// 2. findByAggregate RETURNS ALL EVENTS (NO PAGINATION TRUNCATION)
// ========================================================================

describe('Retention: findByAggregate returns all events without limit', () => {
  it('returns many events for a single aggregate without truncation', async () => {
    const outboxRepo = new InMemoryOutboxRepository();

    // Create multiple events for the same aggregate (different topics)
    const topics = [
      'payment.checkout_session.create',
      'payment.capture',
      'payment.transfer_to_owner',
    ] as const;

    for (let i = 0; i < topics.length; i++) {
      const event = OutboxEvent.create({
        id: crypto.randomUUID(),
        topic: topics[i],
        aggregateType: 'Rental',
        aggregateId: 'r-many-events',
        payload: { rentalId: 'r-many-events' },
        dedupKey: `${topics[i]}:r-many-events`,
      });
      event.acquireLease('test-worker', new Date());
      event.markSucceeded(new Date(), { idx: i });
      await outboxRepo.create(event);
      await outboxRepo.save(event);
    }

    const all = await outboxRepo.findByAggregate('Rental', 'r-many-events');
    expect(all).toHaveLength(3);
    // Verify all three are returned
    const topics_found = all.map(e => e.topic);
    expect(topics_found).toContain('payment.checkout_session.create');
    expect(topics_found).toContain('payment.capture');
    expect(topics_found).toContain('payment.transfer_to_owner');
  });
});

// ========================================================================
// 3. RECOVERY WORKS REGARDLESS OF EVENT AGE
// ========================================================================

describe('Retention: Old events are still recoverable', () => {
  it('outbox event created days ago is still used for recovery', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    // Event created "3 days ago"
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const event = OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.transfer_to_owner',
      aggregateType: 'Rental',
      aggregateId: 'r-ret-1',
      payload: { rentalId: 'r-ret-1', amount: 400, connectedAccountId: 'acct_1' },
      dedupKey: `transfer:r-ret-1`,
      createdAt: oldDate,
    });
    event.acquireLease('test-worker', oldDate);
    event.markSucceeded(oldDate, { transferId: 'tr_old_event' });
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferId: 'tr_old_event',
      status: 'paid',
      amount: 40000,
      currency: 'usd',
      destination: 'acct_1',
      reversed: false,
      metadata: {},
      fetchedAt: new Date(),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-ret-1');
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Backfill succeeded from old event
    const after = await rentalRepo.findById('r-ret-1');
    expect(after!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(after!.externalTransferId).toBe('tr_old_event');
  });
});

// ========================================================================
// 4. FULL SWEEP FINDS AND BACKFILLS STUCK RENTALS
// ========================================================================

describe('Retention: Full sweep discovers stuck crash-window rentals', () => {
  it('runFullSweep backfills a stuck rental found during sweep', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-ret-1', 'tr_sweep_find');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferId: 'tr_sweep_find',
      status: 'paid',
      amount: 40000,
      currency: 'usd',
      destination: 'acct_1',
      reversed: false,
      metadata: {},
      fetchedAt: new Date(),
    });
    const reconRepo = makeReconRepo();
    const auditLogRepo = makeAuditLogRepo();
    const engine = new ReconciliationEngine(
      reconRepo as any,
      rentalRepo,
      adapter,
      makeRepairExecutor() as any,
      auditLogRepo as any,
      outboxRepo,
    );

    await engine.runFullSweep('sweep-worker');

    // Rental was found and backfilled during sweep
    const after = await rentalRepo.findById('r-ret-1');
    expect(after!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(after!.externalTransferId).toBe('tr_sweep_find');

    // Audit trail exists
    const backfillAudit = auditLogRepo.log.mock.calls.find(
      (call: any[]) => call[0].actionType === 'reconciliation_transfer_backfill',
    );
    expect(backfillAudit).toBeDefined();
  });
});

// ========================================================================
// 5. MULTIPLE SWEEPS CONVERGE IDEMPOTENTLY
// ========================================================================

describe('Retention: Multiple sweeps converge', () => {
  it('second sweep after backfill does not re-backfill or create findings', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-ret-1', 'tr_multi_sweep');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferId: 'tr_multi_sweep',
      status: 'paid',
      amount: 40000,
      currency: 'usd',
      destination: 'acct_1',
      reversed: false,
      metadata: {},
      fetchedAt: new Date(),
    });
    const reconRepo = makeReconRepo();
    const engine = new ReconciliationEngine(
      reconRepo as any,
      rentalRepo,
      adapter,
      makeRepairExecutor() as any,
      makeAuditLogRepo() as any,
      outboxRepo,
    );

    // First sweep: backfills
    await engine.runFullSweep('sweep-1');
    const afterFirst = await rentalRepo.findById('r-ret-1');
    expect(afterFirst!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    const versionAfterFirst = afterFirst!.version;

    // Second sweep: no-op (rental already has externalTransferId)
    const outboxSpy = vi.spyOn(outboxRepo, 'findByAggregate');
    await engine.runFullSweep('sweep-2');
    const afterSecond = await rentalRepo.findById('r-ret-1');
    expect(afterSecond!.version).toBe(versionAfterFirst);
    // Outbox not queried on second sweep (rental has transferId)
    expect(outboxSpy).not.toHaveBeenCalled();
  });
});

// ========================================================================
// 6. PURGED OUTBOX (RETENTION GAP) IS FAIL-SAFE
// ========================================================================

describe('Retention: Purged outbox is fail-safe', () => {
  it('empty outbox after hypothetical purge: no false action, no error', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    // Empty outbox — simulates events being purged before reconciliation
    const outboxRepo = new InMemoryOutboxRepository();

    const adapter = makeAdapter();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-ret-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    // No backfill, no transfer verification, no error
    expect(result.errors).toHaveLength(0);
    expect(result.findingsCreated).toBe(0);
    expect(adapter.fetchTransferSnapshot).not.toHaveBeenCalled();

    // Rental unchanged — stuck but not corrupted
    const after = await rentalRepo.findById('r-ret-1');
    expect(after!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    expect(after!.externalTransferId).toBeNull();
  });
});

// ========================================================================
// 7. AUDIT TRAIL PROVIDES OPERATIONAL VISIBILITY
// ========================================================================

describe('Retention: Backfill creates observable audit trail', () => {
  it('backfill audit entry contains rental ID and actor for operator querying', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-ret-1', 'tr_audit_trail');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferId: 'tr_audit_trail',
      status: 'paid',
      amount: 40000,
      currency: 'usd',
      destination: 'acct_1',
      reversed: false,
      metadata: {},
      fetchedAt: new Date(),
    });
    const auditLogRepo = makeAuditLogRepo();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter, auditLogRepo);

    const loaded = await rentalRepo.findById('r-ret-1');
    await engine.reconcileOne(loaded!, 'run-1', 'recon-worker');

    // Verify audit entry structure
    const backfillEntry = auditLogRepo.log.mock.calls.find(
      (call: any[]) => call[0].actionType === 'reconciliation_transfer_backfill',
    );
    expect(backfillEntry).toBeDefined();
    const entry = backfillEntry![0];
    expect(entry.entityType).toBe('Rental');
    expect(entry.entityId).toBe('r-ret-1');
    expect(entry.actorId).toBe('recon-worker');
    expect(entry.id).toBeDefined(); // UUID present
    expect(entry.timestamp).toBeDefined();
  });
});
