import { describe, it, expect, beforeEach } from 'vitest';
import { ReconciliationEngine } from '../../../src/application/services/ReconciliationEngine';
import { RepairExecutor } from '../../../src/application/services/RepairExecutor';
import { InMemoryReconciliationRepository } from '../../../src/infrastructure/repositories/InMemoryReconciliationRepository';
import { InMemoryRentalRepository } from '../../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryFreezeRepository } from '../../../src/infrastructure/repositories/InMemoryFreezeRepository';
import { InMemoryManualReviewRepository } from '../../../src/infrastructure/repositories/InMemoryManualReviewRepository';
import { InMemoryAuditLogRepository } from '../../../src/infrastructure/repositories/InMemoryAuditLogRepository';
import { ProviderSnapshotAdapter, ProviderPaymentSnapshot } from '../../../src/domain/reconciliation/ProviderSnapshot';
import { Rental } from '../../../src/domain/entities/Rental';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../../src/domain/enums/ReconciliationStatus';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeRental(overrides: Partial<{ id: string; escrowStatus: EscrowStatus }> = {}): Rental {
  const rental = Rental.create({
    id: overrides.id ?? 'rental-1',
    renterId: 'renter-1',
    watchId: 'watch-1',
    rentalPrice: 500,
    createdAt: NOW,
  });
  const target = overrides.escrowStatus ?? EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED;
  if (target === EscrowStatus.NOT_STARTED) return rental;
  rental.startExternalPayment('pi_test');
  if (target === EscrowStatus.AWAITING_EXTERNAL_PAYMENT) return rental;
  rental.markPaymentAuthorized();
  if (target === EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED) return rental;
  rental.markPaymentCaptured();
  if (target === EscrowStatus.EXTERNAL_PAYMENT_CAPTURED) return rental;
  if (target === EscrowStatus.DISPUTED) { rental.markDisputed(); return rental; }
  if (target === EscrowStatus.REFUNDED) { rental.markRefunded(); return rental; }
  if (target === EscrowStatus.FUNDS_RELEASED_TO_OWNER) {
    rental.confirmReturn();
    rental.releaseFunds();
    return rental;
  }
  return rental;
}

class TestProviderAdapter implements ProviderSnapshotAdapter {
  private snapshots = new Map<string, ProviderPaymentSnapshot | null>();

  setSnapshot(piId: string, snap: ProviderPaymentSnapshot | null): void {
    this.snapshots.set(piId, snap);
  }

  async fetchPaymentSnapshot(paymentIntentId: string): Promise<ProviderPaymentSnapshot | null> {
    if (this.snapshots.has(paymentIntentId)) return this.snapshots.get(paymentIntentId) ?? null;
    return null;
  }

  async fetchConnectedAccountSnapshot(): Promise<null> {
    return null;
  }
}

describe('ReconciliationEngine', () => {
  let reconRepo: InMemoryReconciliationRepository;
  let rentalRepo: InMemoryRentalRepository;
  let freezeRepo: InMemoryFreezeRepository;
  let reviewRepo: InMemoryManualReviewRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let providerAdapter: TestProviderAdapter;
  let repairExecutor: RepairExecutor;
  let engine: ReconciliationEngine;

  beforeEach(() => {
    reconRepo = new InMemoryReconciliationRepository();
    rentalRepo = new InMemoryRentalRepository();
    freezeRepo = new InMemoryFreezeRepository();
    reviewRepo = new InMemoryManualReviewRepository();
    auditRepo = new InMemoryAuditLogRepository();
    providerAdapter = new TestProviderAdapter();
    repairExecutor = new RepairExecutor(reconRepo, rentalRepo, freezeRepo, reviewRepo, auditRepo);
    engine = new ReconciliationEngine(reconRepo, rentalRepo, providerAdapter, repairExecutor, auditRepo);
  });

  describe('reconcileOne', () => {
    it('skips rental without external payment intent', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.NOT_STARTED });
      await rentalRepo.save(rental);
      const result = await engine.reconcileOne(rental, 'run-1', 'test');
      expect(result.findingsCreated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('detects ORPHAN_INTERNAL_RECORD when provider returns null', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      await rentalRepo.save(rental);
      // Provider returns null for this PI
      const result = await engine.reconcileOne(rental, 'run-1', 'test');
      expect(result.findingsCreated).toBe(1);
    });

    it('auto-repairs PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      await rentalRepo.save(rental);

      providerAdapter.setSnapshot('pi_test', {
        paymentIntentId: 'pi_test',
        status: 'succeeded',
        amountCaptured: 500,
        amountRefunded: 0,
        currency: 'usd',
        disputeOpen: false,
        disputeStatus: null,
        metadata: {},
        fetchedAt: NOW,
      });

      const result = await engine.reconcileOne(rental, 'run-1', 'test');
      expect(result.findingsCreated).toBe(1);
      expect(result.autoRepaired).toBe(1);

      // Verify internal state was synced
      const updated = await rentalRepo.findById('rental-1');
      expect(updated?.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    });

    it('escalates CRITICAL findings with freeze and review', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.FUNDS_RELEASED_TO_OWNER });
      await rentalRepo.save(rental);

      providerAdapter.setSnapshot('pi_test', {
        paymentIntentId: 'pi_test',
        status: 'requires_capture',
        amountCaptured: 0,
        amountRefunded: 0,
        currency: 'usd',
        disputeOpen: false,
        disputeStatus: null,
        metadata: {},
        fetchedAt: NOW,
      });

      const result = await engine.reconcileOne(rental, 'run-1', 'test');
      expect(result.findingsCreated).toBe(1);
      expect(result.escalated).toBe(1);

      // Verify freeze was created
      const freezes = await freezeRepo.findActive('RENTAL', 'rental-1');
      expect(freezes.length).toBeGreaterThan(0);
    });

    it('deduplicates findings — same drift not created twice for open finding', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      await rentalRepo.save(rental);

      // Provider returns null → ORPHAN_INTERNAL_RECORD (not auto-repairable, finding stays OPEN)
      const result1 = await engine.reconcileOne(rental, 'run-1', 'test');
      expect(result1.findingsCreated).toBe(1);

      // Re-fetch the same rental from repo (now it may have been modified by escalation)
      const refetched = await rentalRepo.findById('rental-1');

      // Second reconciliation with same rental — same drift type, finding is still open
      const result2 = await engine.reconcileOne(refetched!, 'run-2', 'test');
      // Should be deduplicated — the existing open finding prevents a new one
      expect(result2.findingsCreated).toBe(0);
    });
  });

  describe('runFullSweep', () => {
    it('creates a run with correct summary for clean state', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.NOT_STARTED });
      await rentalRepo.save(rental);

      const run = await engine.runFullSweep('test-worker');
      expect(run.status).toBe('COMPLETED');
      expect(run.summary.totalChecked).toBe(1);
      expect(run.summary.totalFindings).toBe(0);
    });

    it('processes multiple rentals', async () => {
      // Use different watchIds to avoid double-rental check
      const r1 = Rental.create({ id: 'rental-1', renterId: 'renter-1', watchId: 'watch-1', rentalPrice: 500, createdAt: NOW });
      const r2 = Rental.create({ id: 'rental-2', renterId: 'renter-2', watchId: 'watch-2', rentalPrice: 300, createdAt: NOW });
      await rentalRepo.save(r1);
      await rentalRepo.save(r2);

      const run = await engine.runFullSweep('test-worker');
      expect(run.status).toBe('COMPLETED');
      expect(run.summary.totalChecked).toBe(2);
    });

    it('records run in repository', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.NOT_STARTED });
      await rentalRepo.save(rental);

      const run = await engine.runFullSweep('test');
      const stored = await reconRepo.findRunById(run.id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('COMPLETED');
    });
  });

  describe('reconcileById', () => {
    it('returns error for non-existent rental', async () => {
      const result = await engine.reconcileById('nonexistent', 'admin');
      expect(result.errors).toContain('Rental not found');
    });

    it('reconciles a specific rental on-demand', async () => {
      const rental = makeRental({ escrowStatus: EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED });
      await rentalRepo.save(rental);

      providerAdapter.setSnapshot('pi_test', {
        paymentIntentId: 'pi_test',
        status: 'succeeded',
        amountCaptured: 500,
        amountRefunded: 0,
        currency: 'usd',
        disputeOpen: false,
        disputeStatus: null,
        metadata: {},
        fetchedAt: NOW,
      });

      const result = await engine.reconcileById('rental-1', 'admin');
      expect(result.findingsCreated).toBe(1);
      expect(result.autoRepaired).toBe(1);
    });
  });
});
