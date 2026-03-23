import { describe, it, expect, beforeEach } from 'vitest';
import { RepairExecutor } from '../../../src/application/services/RepairExecutor';
import { ReconciliationFinding } from '../../../src/domain/entities/ReconciliationFinding';
import { InMemoryReconciliationRepository } from '../../../src/infrastructure/repositories/InMemoryReconciliationRepository';
import { InMemoryRentalRepository } from '../../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryFreezeRepository } from '../../../src/infrastructure/repositories/InMemoryFreezeRepository';
import { InMemoryManualReviewRepository } from '../../../src/infrastructure/repositories/InMemoryManualReviewRepository';
import { InMemoryAuditLogRepository } from '../../../src/infrastructure/repositories/InMemoryAuditLogRepository';
import { Rental } from '../../../src/domain/entities/Rental';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../../src/domain/enums/ReconciliationStatus';
import { DomainError } from '../../../src/domain/errors/DomainError';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeRental(escrowStatus: EscrowStatus): Rental {
  const rental = Rental.create({
    id: 'rental-1',
    renterId: 'renter-1',
    watchId: 'watch-1',
    rentalPrice: 500,
    createdAt: NOW,
  });
  if (escrowStatus === EscrowStatus.NOT_STARTED) return rental;
  rental.startExternalPayment('pi_test');
  if (escrowStatus === EscrowStatus.AWAITING_EXTERNAL_PAYMENT) return rental;
  rental.markPaymentAuthorized();
  if (escrowStatus === EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED) return rental;
  rental.markPaymentCaptured();
  if (escrowStatus === EscrowStatus.EXTERNAL_PAYMENT_CAPTURED) return rental;
  if (escrowStatus === EscrowStatus.DISPUTED) { rental.markDisputed(); return rental; }
  return rental;
}

function makeFinding(driftType: DriftType, severity: ReconciliationSeverity): ReconciliationFinding {
  return ReconciliationFinding.create({
    id: 'finding-1',
    runId: 'run-1',
    aggregateType: 'Rental',
    aggregateId: 'rental-1',
    providerObjectIds: ['pi_test'],
    internalSnapshot: {},
    providerSnapshot: {},
    driftType,
    severity,
    recommendedAction: 'SYNC_INTERNAL',
    createdAt: NOW,
  });
}

describe('RepairExecutor', () => {
  let reconRepo: InMemoryReconciliationRepository;
  let rentalRepo: InMemoryRentalRepository;
  let freezeRepo: InMemoryFreezeRepository;
  let reviewRepo: InMemoryManualReviewRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let executor: RepairExecutor;

  beforeEach(() => {
    reconRepo = new InMemoryReconciliationRepository();
    rentalRepo = new InMemoryRentalRepository();
    freezeRepo = new InMemoryFreezeRepository();
    reviewRepo = new InMemoryManualReviewRepository();
    auditRepo = new InMemoryAuditLogRepository();
    executor = new RepairExecutor(reconRepo, rentalRepo, freezeRepo, reviewRepo, auditRepo);
  });

  describe('autoRepair', () => {
    it('syncs captured status when rental is in AUTHORIZED state', async () => {
      const rental = makeRental(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      await rentalRepo.save(rental);

      const finding = makeFinding(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      const result = await executor.autoRepair(finding, 'system');
      expect(result.repaired).toBe(true);
      expect(result.action).toContain('EXTERNAL_PAYMENT_CAPTURED');

      const updated = await rentalRepo.findById('rental-1');
      expect(updated?.escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);

      // Finding should be marked repaired
      expect(finding.status).toBe(ReconciliationStatus.REPAIRED);
    });

    it('is idempotent — already captured rental returns true', async () => {
      const rental = makeRental(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      await rentalRepo.save(rental);

      const finding = makeFinding(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      const result = await executor.autoRepair(finding, 'system');
      expect(result.repaired).toBe(true);
    });

    it('syncs dispute when provider has open dispute', async () => {
      const rental = makeRental(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
      await rentalRepo.save(rental);

      const finding = makeFinding(DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      const result = await executor.autoRepair(finding, 'system');
      expect(result.repaired).toBe(true);

      const updated = await rentalRepo.findById('rental-1');
      expect(updated?.disputeOpen).toBe(true);
    });

    it('rejects auto-repair for non-repairable drifts', async () => {
      const finding = makeFinding(DriftType.ORPHAN_INTERNAL_RECORD, ReconciliationSeverity.CRITICAL);
      const result = await executor.autoRepair(finding, 'system');
      expect(result.repaired).toBe(false);
    });

    it('returns false when rental not found', async () => {
      const finding = makeFinding(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      const result = await executor.autoRepair(finding, 'system');
      expect(result.repaired).toBe(false);
    });
  });

  describe('escalate', () => {
    it('creates freeze for CRITICAL findings', async () => {
      const finding = makeFinding(DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING, ReconciliationSeverity.CRITICAL);
      await reconRepo.createFinding(finding);

      const result = await executor.escalate(finding, 'system');
      expect(result.froze).toBe(true);
      expect(result.reviewCreated).toBe(true);

      const freezes = await freezeRepo.findActive('RENTAL', 'rental-1');
      expect(freezes.length).toBeGreaterThan(0);
      expect(finding.status).toBe(ReconciliationStatus.ESCALATED);
    });

    it('creates manual review case', async () => {
      const finding = makeFinding(DriftType.ORPHAN_INTERNAL_RECORD, ReconciliationSeverity.CRITICAL);
      await reconRepo.createFinding(finding);

      const result = await executor.escalate(finding, 'system');
      expect(result.reviewCreated).toBe(true);

      const reviews = await reviewRepo.findOpenByEntity('Rental', 'rental-1');
      expect(reviews.length).toBeGreaterThan(0);
    });

    it('does not duplicate review cases', async () => {
      const finding1 = makeFinding(DriftType.ORPHAN_INTERNAL_RECORD, ReconciliationSeverity.CRITICAL);
      await reconRepo.createFinding(finding1);
      await executor.escalate(finding1, 'system');

      const finding2 = ReconciliationFinding.create({
        id: 'finding-2',
        runId: 'run-2',
        aggregateType: 'Rental',
        aggregateId: 'rental-1',
        providerObjectIds: ['pi_test'],
        internalSnapshot: {},
        providerSnapshot: {},
        driftType: DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING,
        severity: ReconciliationSeverity.CRITICAL,
        recommendedAction: 'FREEZE_ENTITY',
        createdAt: NOW,
      });
      await reconRepo.createFinding(finding2);
      await executor.escalate(finding2, 'system');

      const reviews = await reviewRepo.findOpenByEntity('Rental', 'rental-1');
      expect(reviews.length).toBe(1); // Deduplication
    });
  });

  describe('manualRepair', () => {
    it('marks finding as repaired with explicit action', async () => {
      const finding = makeFinding(DriftType.REFUND_STATE_MISMATCH, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      const result = await executor.manualRepair(finding, 'admin-1', 'Verified refund processed manually via Stripe dashboard');
      expect(result.repaired).toBe(true);
      expect(finding.status).toBe(ReconciliationStatus.REPAIRED);
      expect(finding.resolvedBy).toBe('admin-1');
    });

    it('rejects empty repair action', async () => {
      const finding = makeFinding(DriftType.REFUND_STATE_MISMATCH, ReconciliationSeverity.HIGH);
      await expect(executor.manualRepair(finding, 'admin', '')).rejects.toThrow(DomainError);
    });
  });

  describe('suppress', () => {
    it('suppresses finding with reason', async () => {
      const finding = makeFinding(DriftType.CONNECTED_ACCOUNT_STATE_MISMATCH, ReconciliationSeverity.LOW);
      await reconRepo.createFinding(finding);

      await executor.suppress(finding, 'admin-1', 'Known timing issue, will self-resolve');
      expect(finding.status).toBe(ReconciliationStatus.SUPPRESSED);
      expect(finding.isResolved()).toBe(true);
    });
  });

  describe('audit logging', () => {
    it('logs audit entry for auto-repair', async () => {
      const rental = makeRental(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
      await rentalRepo.save(rental);

      const finding = makeFinding(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      await executor.autoRepair(finding, 'system');

      const entries = await auditRepo.findByEntityId('finding-1');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].actionType).toBe('reconciliation_auto_repair');
    });

    it('logs audit entry for escalation', async () => {
      const finding = makeFinding(DriftType.ORPHAN_INTERNAL_RECORD, ReconciliationSeverity.CRITICAL);
      await reconRepo.createFinding(finding);

      await executor.escalate(finding, 'system');

      const entries = await auditRepo.findByEntityId('finding-1');
      expect(entries.some(e => e.actionType === 'reconciliation_escalation')).toBe(true);
    });

    it('logs audit entry for manual repair', async () => {
      const finding = makeFinding(DriftType.REFUND_STATE_MISMATCH, ReconciliationSeverity.HIGH);
      await reconRepo.createFinding(finding);

      await executor.manualRepair(finding, 'admin-1', 'manual fix');

      const entries = await auditRepo.findByEntityId('finding-1');
      expect(entries.some(e => e.actionType === 'reconciliation_manual_repair')).toBe(true);
    });

    it('logs audit entry for suppression', async () => {
      const finding = makeFinding(DriftType.CONNECTED_ACCOUNT_STATE_MISMATCH, ReconciliationSeverity.LOW);
      await reconRepo.createFinding(finding);

      await executor.suppress(finding, 'admin-1', 'benign');

      const entries = await auditRepo.findByEntityId('finding-1');
      expect(entries.some(e => e.actionType === 'reconciliation_suppress')).toBe(true);
    });
  });
});
