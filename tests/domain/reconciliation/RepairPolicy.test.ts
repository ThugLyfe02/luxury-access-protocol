import { describe, it, expect } from 'vitest';
import { RepairPolicy } from '../../../src/domain/reconciliation/RepairPolicy';
import { ReconciliationFinding } from '../../../src/domain/entities/ReconciliationFinding';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../../src/domain/enums/ReconciliationStatus';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeFinding(overrides: Partial<{
  driftType: DriftType;
  severity: ReconciliationSeverity;
}> = {}): ReconciliationFinding {
  return ReconciliationFinding.create({
    id: 'finding-1',
    runId: 'run-1',
    aggregateType: 'Rental',
    aggregateId: 'rental-1',
    providerObjectIds: ['pi_test'],
    internalSnapshot: {},
    providerSnapshot: {},
    driftType: overrides.driftType ?? DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED,
    severity: overrides.severity ?? ReconciliationSeverity.HIGH,
    recommendedAction: 'SYNC_INTERNAL',
    createdAt: NOW,
  });
}

describe('RepairPolicy', () => {
  describe('canAutoRepair', () => {
    it('allows auto-repair for PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED', () => {
      const finding = makeFinding({ driftType: DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED });
      const decision = RepairPolicy.canAutoRepair(finding);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.action).toContain('EXTERNAL_PAYMENT_CAPTURED');
      }
    });

    it('allows auto-repair for PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN', () => {
      const finding = makeFinding({ driftType: DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN });
      const decision = RepairPolicy.canAutoRepair(finding);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.action).toContain('DISPUTED');
      }
    });

    it('rejects auto-repair for INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING', () => {
      const finding = makeFinding({ driftType: DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING });
      const decision = RepairPolicy.canAutoRepair(finding);
      expect(decision.allowed).toBe(false);
    });

    it('rejects auto-repair for REFUND_STATE_MISMATCH', () => {
      const finding = makeFinding({ driftType: DriftType.REFUND_STATE_MISMATCH });
      const decision = RepairPolicy.canAutoRepair(finding);
      expect(decision.allowed).toBe(false);
    });

    it('rejects auto-repair for ORPHAN_INTERNAL_RECORD', () => {
      const finding = makeFinding({ driftType: DriftType.ORPHAN_INTERNAL_RECORD });
      const decision = RepairPolicy.canAutoRepair(finding);
      expect(decision.allowed).toBe(false);
    });

    it('rejects auto-repair for already-resolved finding', () => {
      const finding = makeFinding({ driftType: DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED });
      finding.markRepaired('admin', 'manual fix', NOW);
      const decision = RepairPolicy.canAutoRepair(finding);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toContain('already resolved');
      }
    });
  });

  describe('requiresFreeze', () => {
    it('returns true for CRITICAL drifts that require freeze', () => {
      expect(RepairPolicy.requiresFreeze(DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING)).toBe(true);
      expect(RepairPolicy.requiresFreeze(DriftType.INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED)).toBe(true);
      expect(RepairPolicy.requiresFreeze(DriftType.DUPLICATE_PROVIDER_REFERENCE)).toBe(true);
      expect(RepairPolicy.requiresFreeze(DriftType.ORPHAN_INTERNAL_RECORD)).toBe(true);
    });

    it('returns false for auto-repairable drifts', () => {
      expect(RepairPolicy.requiresFreeze(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED)).toBe(false);
      expect(RepairPolicy.requiresFreeze(DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN)).toBe(false);
    });
  });

  describe('requiresReview', () => {
    it('returns true for drifts that need human review', () => {
      expect(RepairPolicy.requiresReview(DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING)).toBe(true);
      expect(RepairPolicy.requiresReview(DriftType.REFUND_STATE_MISMATCH)).toBe(true);
      expect(RepairPolicy.requiresReview(DriftType.ORPHAN_PROVIDER_OBJECT)).toBe(true);
    });

    it('returns false for auto-repairable drifts', () => {
      expect(RepairPolicy.requiresReview(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED)).toBe(false);
      expect(RepairPolicy.requiresReview(DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN)).toBe(false);
    });

    it('returns false for CONNECTED_ACCOUNT_STATE_MISMATCH', () => {
      expect(RepairPolicy.requiresReview(DriftType.CONNECTED_ACCOUNT_STATE_MISMATCH)).toBe(false);
    });
  });

  describe('describeRepairAction', () => {
    it('describes capture sync', () => {
      const action = RepairPolicy.describeRepairAction(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED);
      expect(action).toContain('EXTERNAL_PAYMENT_CAPTURED');
    });

    it('describes dispute sync', () => {
      const action = RepairPolicy.describeRepairAction(DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN);
      expect(action).toContain('DISPUTED');
    });

    it('returns no auto-repair message for non-repairable types', () => {
      const action = RepairPolicy.describeRepairAction(DriftType.ORPHAN_INTERNAL_RECORD);
      expect(action).toContain('No auto-repair');
    });
  });
});
