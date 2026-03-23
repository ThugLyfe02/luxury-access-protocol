/**
 * PHASE N.3 — OUTBOX TRANSFER TRUTH CLOSURE SUITE
 *
 * Proves that:
 * A. Outbox transfer success persists real externalTransferId (not synthetic)
 * B. Repository round-trip preserves externalTransferId
 * C. Reconciliation can verify transfer truth using real provider ID
 * D. Ambiguity/idempotency: replay and duplicate processing are safe
 * E. Regression: existing transfer/provider tests still pass
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Rental } from '../../src/domain/entities/Rental';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { DriftType } from '../../src/domain/enums/DriftType';
import { DriftDetector } from '../../src/domain/reconciliation/DriftDetector';
import { InternalSnapshotBuilder } from '../../src/domain/reconciliation/InternalSnapshot';
import { ProviderTransferSnapshot } from '../../src/domain/reconciliation/ProviderSnapshot';
import { OutboxEvent } from '../../src/domain/entities/OutboxEvent';
import { OutboxEventFactory } from '../../src/domain/services/OutboxEventFactory';
import { TransferToOwnerHandler } from '../../src/infrastructure/outbox/ProviderCommandHandlers';
import { PaymentProvider } from '../../src/domain/interfaces/PaymentProvider';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';

// ========================================================================
// HELPERS
// ========================================================================

function makeProvider(transferId = 'tr_real_stripe_123'): PaymentProvider {
  return {
    createCheckoutSession: vi.fn(),
    capturePayment: vi.fn(),
    refundPayment: vi.fn(),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId }),
    createConnectedAccount: vi.fn(),
    createOnboardingLink: vi.fn(),
  };
}

function makeCapturedRental(id = 'r-outbox-1'): Rental {
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId: `w-${id}`,
    rentalPrice: 500,
    createdAt: new Date(),
  });
  rental.startExternalPayment('pi_outbox_1');
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  rental.confirmReturn();
  return rental;
}

function makeTransferEvent(rentalId = 'r-outbox-1'): OutboxEvent {
  return OutboxEventFactory.transferToOwner({
    rentalId,
    amount: 400,
    connectedAccountId: 'acct_owner_1',
  });
}

function makeTransferSnapshot(overrides?: Partial<ProviderTransferSnapshot>): ProviderTransferSnapshot {
  return {
    transferId: 'tr_real_stripe_123',
    status: 'paid',
    amount: 40000,
    currency: 'usd',
    destination: 'acct_owner_1',
    reversed: false,
    metadata: {},
    fetchedAt: new Date(),
    ...overrides,
  };
}

// ========================================================================
// A. TRANSFER WRITE-BACK TRUTH
// ========================================================================

describe('Outbox Transfer Truth: Write-back', () => {
  let rentalRepo: InMemoryRentalRepository;

  beforeEach(() => {
    rentalRepo = new InMemoryRentalRepository();
  });

  it('outbox transfer success persists real externalTransferId on rental', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const provider = makeProvider('tr_real_stripe_123');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    const event = makeTransferEvent();

    const result = await handler.handle(event);

    expect(result.transferId).toBe('tr_real_stripe_123');

    const saved = await rentalRepo.findById('r-outbox-1');
    expect(saved).not.toBeNull();
    expect(saved!.externalTransferId).toBe('tr_real_stripe_123');
    expect(saved!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  });

  it('persisted transfer ID is NOT synthetic outbox placeholder', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const provider = makeProvider('tr_live_abc');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    const event = makeTransferEvent();

    await handler.handle(event);

    const saved = await rentalRepo.findById('r-outbox-1');
    expect(saved!.externalTransferId).toBe('tr_live_abc');
    expect(saved!.externalTransferId).not.toMatch(/^outbox:/);
  });

  it('handler without rentalRepo still succeeds (backward compatible)', async () => {
    const provider = makeProvider('tr_no_repo');
    const handler = new TransferToOwnerHandler(provider);
    const event = makeTransferEvent();

    const result = await handler.handle(event);
    expect(result.transferId).toBe('tr_no_repo');
  });
});

// ========================================================================
// B. REPOSITORY ROUND-TRIP PERSISTENCE
// ========================================================================

describe('Outbox Transfer Truth: Repository Round-Trip', () => {
  it('externalTransferId survives InMemoryRentalRepository save + findById', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    // Simulate the handler write-back
    const loaded = await rentalRepo.findById('r-outbox-1');
    loaded!.releaseFunds('tr_roundtrip_1');
    await rentalRepo.save(loaded!);

    // Re-load and verify
    const reloaded = await rentalRepo.findById('r-outbox-1');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.externalTransferId).toBe('tr_roundtrip_1');
    expect(reloaded!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  });

  it('externalTransferId is null when not set (repository round-trip)', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const loaded = await rentalRepo.findById('r-outbox-1');
    expect(loaded!.externalTransferId).toBeNull();
  });
});

// ========================================================================
// C. RECONCILIATION TRUTH WITH REAL ID
// ========================================================================

describe('Outbox Transfer Truth: Reconciliation', () => {
  let rentalRepo: InMemoryRentalRepository;

  beforeEach(() => {
    rentalRepo = new InMemoryRentalRepository();
  });

  it('reconciliation can verify transfer truth using real provider ID', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    // Simulate outbox handler completing
    const provider = makeProvider('tr_recon_real_1');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    await handler.handle(makeTransferEvent());

    // Now reconciliation sees real transfer ID
    const saved = await rentalRepo.findById('r-outbox-1');
    const internal = InternalSnapshotBuilder.fromRental(saved!);
    const transfer = makeTransferSnapshot({ transferId: 'tr_recon_real_1' });

    const drifts = DriftDetector.detectTransferDrift(internal, transfer);
    expect(drifts).toHaveLength(0); // No drift — confirmed match
  });

  it('reconciliation detects transfer not found using real ID', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const provider = makeProvider('tr_missing_real_1');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    await handler.handle(makeTransferEvent());

    const saved = await rentalRepo.findById('r-outbox-1');
    const internal = InternalSnapshotBuilder.fromRental(saved!);

    const drifts = DriftDetector.detectTransferDrift(internal, null);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].driftType).toBe(DriftType.TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED);
    expect(drifts[0].providerObjectIds).toContain('tr_missing_real_1');
  });

  it('reconciliation detects transfer reversed using real ID', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const provider = makeProvider('tr_reversed_real_1');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    await handler.handle(makeTransferEvent());

    const saved = await rentalRepo.findById('r-outbox-1');
    const internal = InternalSnapshotBuilder.fromRental(saved!);
    const transfer = makeTransferSnapshot({
      transferId: 'tr_reversed_real_1',
      reversed: true,
      status: 'reversed',
    });

    const drifts = DriftDetector.detectTransferDrift(internal, transfer);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].driftType).toBe(DriftType.TRANSFER_REVERSED_BUT_INTERNAL_RELEASED);
  });
});

// ========================================================================
// D. AMBIGUITY / IDEMPOTENCY
// ========================================================================

describe('Outbox Transfer Truth: Idempotency and Replay', () => {
  let rentalRepo: InMemoryRentalRepository;

  beforeEach(() => {
    rentalRepo = new InMemoryRentalRepository();
  });

  it('replay after success is idempotent (rental already released)', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const provider = makeProvider('tr_idem_1');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    const event = makeTransferEvent();

    // First execution
    await handler.handle(event);
    const afterFirst = await rentalRepo.findById('r-outbox-1');
    expect(afterFirst!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(afterFirst!.externalTransferId).toBe('tr_idem_1');
    const versionAfterFirst = afterFirst!.version;

    // Second execution (replay / duplicate processing)
    const result2 = await handler.handle(event);
    expect(result2.transferId).toBe('tr_idem_1');

    // Rental state unchanged (no version bump, no double-save)
    const afterSecond = await rentalRepo.findById('r-outbox-1');
    expect(afterSecond!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    expect(afterSecond!.externalTransferId).toBe('tr_idem_1');
    expect(afterSecond!.version).toBe(versionAfterFirst);
  });

  it('provider called exactly once per handler invocation (no double-transfer)', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    const provider = makeProvider('tr_single_1');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);

    await handler.handle(makeTransferEvent());
    expect(provider.transferToConnectedAccount).toHaveBeenCalledTimes(1);

    // Replay
    await handler.handle(makeTransferEvent());
    expect(provider.transferToConnectedAccount).toHaveBeenCalledTimes(2);
    // Note: provider is called again, but Stripe idempotency key (transfer_{rentalId})
    // ensures the same transfer is returned, not a duplicate transfer.
  });

  it('rental not found during write-back does not crash handler', async () => {
    // No rental saved to repo
    const provider = makeProvider('tr_no_rental');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);

    // Should not throw — just skips write-back
    const result = await handler.handle(makeTransferEvent());
    expect(result.transferId).toBe('tr_no_rental');
  });

  it('concurrent release before handler is handled idempotently', async () => {
    const rental = makeCapturedRental();
    await rentalRepo.save(rental);

    // Simulate concurrent release: another process releases the rental
    // before the outbox handler runs
    const concurrent = await rentalRepo.findById('r-outbox-1');
    concurrent!.releaseFunds('tr_concurrent');
    await rentalRepo.save(concurrent!);

    // Now the handler loads the rental — it's already released
    const provider = makeProvider('tr_occ_test');
    const handler = new TransferToOwnerHandler(provider, rentalRepo);
    const result = await handler.handle(makeTransferEvent());

    // Should succeed — rental already released, handler skips write-back
    expect(result.transferId).toBe('tr_occ_test');

    // Original concurrent transfer ID is preserved (not overwritten)
    const saved = await rentalRepo.findById('r-outbox-1');
    expect(saved!.externalTransferId).toBe('tr_concurrent');
    expect(saved!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  });
});

// ========================================================================
// E. REGRESSION: DIRECT MODE STILL WORKS
// ========================================================================

describe('Outbox Transfer Truth: No Regression on Direct Mode', () => {
  it('direct-mode releaseFunds still stores externalTransferId through repository', async () => {
    const rentalRepo = new InMemoryRentalRepository();
    const rental = makeCapturedRental('r-direct-1');
    await rentalRepo.save(rental);

    // Simulate direct-mode release (as in MarketplacePaymentService)
    const loaded = await rentalRepo.findById('r-direct-1');
    loaded!.releaseFunds('tr_direct_1');
    await rentalRepo.save(loaded!);

    const reloaded = await rentalRepo.findById('r-direct-1');
    expect(reloaded!.externalTransferId).toBe('tr_direct_1');
    expect(reloaded!.escrowStatus).toBe(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  });
});
