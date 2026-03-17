/**
 * PHASE N.6 — TRANSFER BACKFILL / RECOVERY COMPLETION SUITE
 *
 * Proves that crash-window transfer truth actually converges from
 * outbox-only truth to durable rental truth via reconciliation backfill.
 *
 * Tests:
 * 1. Backfill succeeds: rental durably updated from CAPTURED → RELEASED + transferId
 * 2. Re-running reconciliation after backfill is idempotent
 * 3. Backfill never triggers a second provider transfer
 * 4. Recovered transfer reversed at provider → CRITICAL finding + freeze
 * 5. Recovered transfer not found at provider → CRITICAL finding + freeze
 * 6. Persisted externalTransferId always wins (no outbox query)
 * 7. Conflicting truth: persisted vs fallback cannot overwrite
 * 8. Malformed outbox result does not trigger backfill
 * 9. Missing both truth sources does not pretend success
 * 10. Backfill fails due to dispute lock → not stuck, drift detection continues
 * 11. Backfill audited for operational visibility
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Rental } from '../../src/domain/entities/Rental';
import { OutboxEvent } from '../../src/domain/entities/OutboxEvent';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { DriftType } from '../../src/domain/enums/DriftType';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryOutboxRepository } from '../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { ReconciliationEngine } from '../../src/application/services/ReconciliationEngine';

// ========================================================================
// HELPERS
// ========================================================================

function makeCapturedRental(id = 'r-bf-1'): Rental {
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

function makePaymentSnapshot(piId: string) {
  return {
    paymentIntentId: piId,
    status: 'succeeded' as const,
    amountCaptured: 50000,
    amountRefunded: 0,
    currency: 'usd',
    disputeOpen: false,
    disputeStatus: null,
    metadata: {},
    fetchedAt: new Date(),
  };
}

function makeTransferSnapshot(transferId: string, opts?: { reversed?: boolean; status?: string }) {
  return {
    transferId,
    status: opts?.status ?? 'paid',
    amount: 40000,
    currency: 'usd',
    destination: 'acct_1',
    reversed: opts?.reversed ?? false,
    metadata: {},
    fetchedAt: new Date(),
  };
}

function makeAdapter(opts?: {
  transferSnapshot?: unknown;
  fetchTransferSnapshot?: ReturnType<typeof vi.fn>;
}) {
  return {
    fetchPaymentSnapshot: vi.fn().mockImplementation((piId: string) =>
      Promise.resolve(makePaymentSnapshot(piId)),
    ),
    fetchTransferSnapshot: opts?.fetchTransferSnapshot ??
      vi.fn().mockResolvedValue(opts?.transferSnapshot ?? null),
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
  reconRepo?: ReturnType<typeof makeReconRepo>,
  auditLogRepo?: ReturnType<typeof makeAuditLogRepo>,
  repairExecutor?: ReturnType<typeof makeRepairExecutor>,
) {
  return new ReconciliationEngine(
    (reconRepo ?? makeReconRepo()) as any,
    rentalRepo,
    adapter ?? makeAdapter(),
    (repairExecutor ?? makeRepairExecutor()) as any,
    (auditLogRepo ?? makeAuditLogRepo()) as any,
    outboxRepo,
  );
}

// ========================================================================
// 1. BACKFILL SUCCEEDS: RENTAL DURABLY UPDATED
// ========================================================================

describe('N.6 Backfill: Rental durably updated after reconciliation', () => {
  it('crash-window rental is backfilled from CAPTURED to RELEASED with transferId', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    expect(rental.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    expect(rental.externalTransferId).toBeNull();

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_backfill_real');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_backfill_real'),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Rental is now durably updated
    const backfilled = await rentalRepo.findById('r-bf-1');
    expect(backfilled!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(backfilled!.externalTransferId).toBe('tr_backfill_real');

    // No errors, no drift findings (backfill fixed the gap, transfer matches provider)
    expect(result.errors).toHaveLength(0);
    expect(result.findingsCreated).toBe(0);
  });
});

// ========================================================================
// 2. RE-RUNNING RECONCILIATION AFTER BACKFILL IS IDEMPOTENT
// ========================================================================

describe('N.6 Idempotency: Re-reconciliation after backfill', () => {
  it('second reconciliation run finds rental already released, no backfill, no findings', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_idem_backfill');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_idem_backfill'),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    // First run: backfills
    const loaded1 = await rentalRepo.findById('r-bf-1');
    await engine.reconcileOne(loaded1!, 'run-1', 'system');

    const afterFirst = await rentalRepo.findById('r-bf-1');
    expect(afterFirst!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    const versionAfterFirst = afterFirst!.version;

    // Second run: rental already has externalTransferId, outbox not queried
    const loaded2 = await rentalRepo.findById('r-bf-1');
    const outboxSpy = vi.spyOn(outboxRepo, 'findByAggregate');
    const result2 = await engine.reconcileOne(loaded2!, 'run-2', 'system');

    // Outbox was not queried (rental already has externalTransferId)
    expect(outboxSpy).not.toHaveBeenCalled();

    // No version bump — rental not modified again
    const afterSecond = await rentalRepo.findById('r-bf-1');
    expect(afterSecond!.version).toBe(versionAfterFirst);

    // No findings
    expect(result2.findingsCreated).toBe(0);
    expect(result2.errors).toHaveLength(0);
  });
});

// ========================================================================
// 3. BACKFILL NEVER TRIGGERS SECOND PROVIDER TRANSFER
// ========================================================================

describe('N.6 No duplicate money: Backfill is pure state completion', () => {
  it('backfill does not call any provider method', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_no_dup');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_no_dup'),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Only fetchPaymentSnapshot and fetchTransferSnapshot called (read-only)
    // No transfer creation method called
    expect(adapter.fetchPaymentSnapshot).toHaveBeenCalledTimes(1);
    expect(adapter.fetchTransferSnapshot).toHaveBeenCalledTimes(1);
    // No other provider methods
    expect(adapter.fetchConnectedAccountSnapshot).not.toHaveBeenCalled();
  });
});

// ========================================================================
// 4. RECOVERED TRANSFER REVERSED → CRITICAL FINDING + ESCALATION
// ========================================================================

describe('N.6 Reversed transfer: Conservative escalation after backfill', () => {
  it('backfill succeeds then reversed transfer produces CRITICAL finding', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_reversed_bf');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_reversed_bf', { reversed: true, status: 'reversed' }),
    });
    const reconRepo = makeReconRepo();
    const repairExecutor = makeRepairExecutor();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter, reconRepo, undefined, repairExecutor);

    const loaded = await rentalRepo.findById('r-bf-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Backfill should have succeeded (rental now RELEASED)
    const afterRecon = await rentalRepo.findById('r-bf-1');
    expect(afterRecon!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);

    // Finding created for reversed transfer
    expect(result.findingsCreated).toBe(1);
    expect(reconRepo.createFinding).toHaveBeenCalledTimes(1);
    const finding = reconRepo.createFinding.mock.calls[0][0];
    expect(finding.driftType).toBe(DriftType.TRANSFER_REVERSED_BUT_INTERNAL_RELEASED);
    expect(finding.severity).toBe('CRITICAL');

    // Escalated (freeze + review)
    expect(repairExecutor.escalate).toHaveBeenCalled();
    expect(result.escalated).toBe(1);
  });
});

// ========================================================================
// 5. RECOVERED TRANSFER NOT FOUND AT PROVIDER → CRITICAL FINDING
// ========================================================================

describe('N.6 Transfer not found: Conservative escalation after backfill', () => {
  it('backfill succeeds then provider 404 produces CRITICAL finding', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_notfound_bf');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    // Provider returns null for transfer (not found)
    const adapter = makeAdapter({ transferSnapshot: null });
    const reconRepo = makeReconRepo();
    const repairExecutor = makeRepairExecutor();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter, reconRepo, undefined, repairExecutor);

    const loaded = await rentalRepo.findById('r-bf-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Backfill should have succeeded
    const afterRecon = await rentalRepo.findById('r-bf-1');
    expect(afterRecon!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);

    // Finding created for transfer not found
    expect(result.findingsCreated).toBe(1);
    const finding = reconRepo.createFinding.mock.calls[0][0];
    expect(finding.driftType).toBe(DriftType.TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED);
    expect(finding.severity).toBe('CRITICAL');

    // Escalated
    expect(repairExecutor.escalate).toHaveBeenCalled();
  });
});

// ========================================================================
// 6. PERSISTED externalTransferId ALWAYS WINS
// ========================================================================

describe('N.6 Precedence: Persisted truth wins, no backfill attempted', () => {
  it('rental with externalTransferId skips outbox entirely', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    rental.releaseFunds('tr_persisted');
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const findSpy = vi.spyOn(outboxRepo, 'findByAggregate');

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_persisted'),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    expect(findSpy).not.toHaveBeenCalled();
    expect(adapter.fetchTransferSnapshot).toHaveBeenCalledWith('tr_persisted');
    expect(result.findingsCreated).toBe(0);
  });
});

// ========================================================================
// 7. CONFLICTING TRUTH: PERSISTED VS FALLBACK CANNOT OVERWRITE
// ========================================================================

describe('N.6 Conflict: Structural impossibility of overwrite', () => {
  it('if rental has externalTransferId, outbox different value is never seen', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    rental.releaseFunds('tr_winner');
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_loser');
    await outboxRepo.create(event);
    await outboxRepo.save(event);
    const findSpy = vi.spyOn(outboxRepo, 'findByAggregate');

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_winner'),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Outbox never queried
    expect(findSpy).not.toHaveBeenCalled();
    // Provider queried with persisted value
    expect(adapter.fetchTransferSnapshot).toHaveBeenCalledWith('tr_winner');

    // Rental unchanged
    const after = await rentalRepo.findById('r-bf-1');
    expect(after!.externalTransferId).toBe('tr_winner');
  });
});

// ========================================================================
// 8. MALFORMED OUTBOX RESULT DOES NOT TRIGGER BACKFILL
// ========================================================================

describe('N.6 Malformed: No backfill from bad outbox result', () => {
  it('outbox event with empty transferId does not trigger backfill', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.transfer_to_owner',
      aggregateType: 'Rental',
      aggregateId: 'r-bf-1',
      payload: { rentalId: 'r-bf-1', amount: 400, connectedAccountId: 'acct_1' },
      dedupKey: `transfer:r-bf-1`,
    });
    event.acquireLease('test-worker', new Date());
    event.markSucceeded(new Date(), { transferId: '' });
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Rental unchanged — no backfill
    const after = await rentalRepo.findById('r-bf-1');
    expect(after!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    expect(after!.externalTransferId).toBeNull();
    expect(adapter.fetchTransferSnapshot).not.toHaveBeenCalled();
  });
});

// ========================================================================
// 9. MISSING BOTH TRUTH SOURCES
// ========================================================================

describe('N.6 Missing truth: No pretend success', () => {
  it('no persisted transferId + no outbox events = no backfill, no transfer verification', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    // No events at all

    const adapter = makeAdapter();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    expect(adapter.fetchTransferSnapshot).not.toHaveBeenCalled();
    expect(result.findingsCreated).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Rental unchanged
    const after = await rentalRepo.findById('r-bf-1');
    expect(after!.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    expect(after!.externalTransferId).toBeNull();
  });
});

// ========================================================================
// 10. BACKFILL FAILS DUE TO DISPUTE → DRIFT DETECTION CONTINUES
// ========================================================================

describe('N.6 Blocked backfill: Dispute lock prevents release', () => {
  it('dispute opened after crash → backfill fails → rental stays DISPUTED, no backfill', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    // Dispute opened between crash and reconciliation
    rental.markDisputed();
    await rentalRepo.save(rental);

    expect(rental.escrowStatus).toBe(EscrowStatus.DISPUTED);
    expect(rental.disputeOpen).toBe(true);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_disputed_bf');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_disputed_bf'),
    });
    const engine = makeEngine(rentalRepo, outboxRepo, adapter);

    const loaded = await rentalRepo.findById('r-bf-1');
    const result = await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Rental stays in DISPUTED — backfill failed (releaseFunds throws DISPUTE_LOCK)
    const after = await rentalRepo.findById('r-bf-1');
    expect(after!.escrowStatus).toBe(EscrowStatus.DISPUTED);
    expect(after!.externalTransferId).toBeNull();

    // Transfer snapshot still queried (outbox recovery found the transferId)
    expect(adapter.fetchTransferSnapshot).toHaveBeenCalledWith('tr_disputed_bf');

    // No errors reported (backfill failure is caught internally)
    expect(result.errors).toHaveLength(0);
  });
});

// ========================================================================
// 11. BACKFILL IS AUDITED FOR OPERATIONAL VISIBILITY
// ========================================================================

describe('N.6 Visibility: Backfill is audit-logged', () => {
  it('successful backfill creates audit log entry', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_audited');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_audited'),
    });
    const auditLogRepo = makeAuditLogRepo();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter, undefined, auditLogRepo);

    const loaded = await rentalRepo.findById('r-bf-1');
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Audit log should contain backfill entry
    const auditCalls = auditLogRepo.log.mock.calls;
    const backfillAudit = auditCalls.find(
      (call: any[]) => call[0].actionType === 'reconciliation_transfer_backfill',
    );
    expect(backfillAudit).toBeDefined();
    expect(backfillAudit![0].entityType).toBe('Rental');
    expect(backfillAudit![0].entityId).toBe('r-bf-1');
    expect(backfillAudit![0].actorId).toBe('system');
  });

  it('failed backfill does NOT create audit log entry', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    rental.markDisputed(); // Will prevent releaseFunds
    await rentalRepo.save(rental);

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_fail_audit');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_fail_audit'),
    });
    const auditLogRepo = makeAuditLogRepo();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter, undefined, auditLogRepo);

    const loaded = await rentalRepo.findById('r-bf-1');
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // No backfill audit entry (backfill failed)
    const backfillAudit = auditLogRepo.log.mock.calls.find(
      (call: any[]) => call[0].actionType === 'reconciliation_transfer_backfill',
    );
    expect(backfillAudit).toBeUndefined();
  });
});

// ========================================================================
// 12. ALREADY-RELEASED RENTAL SKIPS BACKFILL (IDEMPOTENT)
// ========================================================================

describe('N.6 Idempotency: Already-released rental not re-backfilled', () => {
  it('rental already in RELEASED state with null externalTransferId gets backfill skipped', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    // Simulate: rental was released without transferId (edge case)
    rental.releaseFunds();
    await rentalRepo.save(rental);

    expect(rental.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(rental.externalTransferId).toBeNull();

    const outboxRepo = new InMemoryOutboxRepository();
    const event = makeSucceededTransferEvent('r-bf-1', 'tr_already_released');
    await outboxRepo.create(event);
    await outboxRepo.save(event);

    const adapter = makeAdapter({
      transferSnapshot: makeTransferSnapshot('tr_already_released'),
    });
    const auditLogRepo = makeAuditLogRepo();
    const engine = makeEngine(rentalRepo, outboxRepo, adapter, undefined, auditLogRepo);

    const loaded = await rentalRepo.findById('r-bf-1');
    const versionBefore = loaded!.version;
    await engine.reconcileOne(loaded!, 'run-1', 'system');

    // Version unchanged — no save occurred
    const after = await rentalRepo.findById('r-bf-1');
    expect(after!.version).toBe(versionBefore);

    // No backfill audit (skipped because already released)
    const backfillAudit = auditLogRepo.log.mock.calls.find(
      (call: any[]) => call[0].actionType === 'reconciliation_transfer_backfill',
    );
    expect(backfillAudit).toBeUndefined();

    // Transfer still verified via outbox fallback
    expect(adapter.fetchTransferSnapshot).toHaveBeenCalledWith('tr_already_released');
  });
});
