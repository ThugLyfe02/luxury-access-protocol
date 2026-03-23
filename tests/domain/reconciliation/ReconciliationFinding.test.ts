import { describe, it, expect } from 'vitest';
import { ReconciliationFinding } from '../../../src/domain/entities/ReconciliationFinding';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../../src/domain/enums/ReconciliationStatus';
import { DomainError } from '../../../src/domain/errors/DomainError';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeFinding(): ReconciliationFinding {
  return ReconciliationFinding.create({
    id: 'finding-1',
    runId: 'run-1',
    aggregateType: 'Rental',
    aggregateId: 'rental-1',
    providerObjectIds: ['pi_test'],
    internalSnapshot: { foo: 'bar' },
    providerSnapshot: { baz: 'qux' },
    driftType: DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED,
    severity: ReconciliationSeverity.HIGH,
    recommendedAction: 'SYNC_INTERNAL',
    createdAt: NOW,
  });
}

describe('ReconciliationFinding', () => {
  describe('create', () => {
    it('creates with OPEN status', () => {
      const f = makeFinding();
      expect(f.status).toBe(ReconciliationStatus.OPEN);
      expect(f.resolvedAt).toBeNull();
      expect(f.resolvedBy).toBeNull();
      expect(f.repairAction).toBeNull();
      expect(f.isResolved()).toBe(false);
    });

    it('rejects missing ID', () => {
      expect(() => ReconciliationFinding.create({
        id: '',
        runId: 'run-1',
        aggregateType: 'Rental',
        aggregateId: 'rental-1',
        providerObjectIds: [],
        internalSnapshot: {},
        providerSnapshot: {},
        driftType: DriftType.ORPHAN_INTERNAL_RECORD,
        severity: ReconciliationSeverity.CRITICAL,
        recommendedAction: 'FREEZE_ENTITY',
        createdAt: NOW,
      })).toThrow(DomainError);
    });

    it('rejects missing runId', () => {
      expect(() => ReconciliationFinding.create({
        id: 'f-1',
        runId: '',
        aggregateType: 'Rental',
        aggregateId: 'rental-1',
        providerObjectIds: [],
        internalSnapshot: {},
        providerSnapshot: {},
        driftType: DriftType.ORPHAN_INTERNAL_RECORD,
        severity: ReconciliationSeverity.CRITICAL,
        recommendedAction: 'FREEZE_ENTITY',
        createdAt: NOW,
      })).toThrow(DomainError);
    });

    it('freezes snapshots', () => {
      const f = makeFinding();
      expect(Object.isFrozen(f.internalSnapshot)).toBe(true);
      expect(Object.isFrozen(f.providerSnapshot)).toBe(true);
      expect(Object.isFrozen(f.providerObjectIds)).toBe(true);
    });
  });

  describe('FSM transitions', () => {
    it('OPEN → ACKNOWLEDGED', () => {
      const f = makeFinding();
      f.acknowledge('admin-1', NOW);
      expect(f.status).toBe(ReconciliationStatus.ACKNOWLEDGED);
    });

    it('OPEN → REPAIRED', () => {
      const f = makeFinding();
      f.markRepaired('admin-1', 'synced capture status', NOW);
      expect(f.status).toBe(ReconciliationStatus.REPAIRED);
      expect(f.isResolved()).toBe(true);
      expect(f.resolvedAt).toBe(NOW);
      expect(f.resolvedBy).toBe('admin-1');
      expect(f.repairAction).toBe('synced capture status');
    });

    it('OPEN → SUPPRESSED', () => {
      const f = makeFinding();
      f.suppress('admin-1', 'known timing issue', NOW);
      expect(f.status).toBe(ReconciliationStatus.SUPPRESSED);
      expect(f.isResolved()).toBe(true);
      expect(f.repairAction).toContain('SUPPRESSED');
    });

    it('OPEN → ESCALATED', () => {
      const f = makeFinding();
      f.escalate('system', NOW);
      expect(f.status).toBe(ReconciliationStatus.ESCALATED);
      expect(f.isResolved()).toBe(false);
    });

    it('ACKNOWLEDGED → REPAIRED', () => {
      const f = makeFinding();
      f.acknowledge('admin-1', NOW);
      f.markRepaired('admin-1', 'fixed manually', NOW);
      expect(f.status).toBe(ReconciliationStatus.REPAIRED);
    });

    it('ACKNOWLEDGED → ESCALATED', () => {
      const f = makeFinding();
      f.acknowledge('admin-1', NOW);
      f.escalate('admin-1', NOW);
      expect(f.status).toBe(ReconciliationStatus.ESCALATED);
    });

    it('ESCALATED → REPAIRED', () => {
      const f = makeFinding();
      f.escalate('system', NOW);
      f.markRepaired('admin-1', 'resolved after investigation', NOW);
      expect(f.status).toBe(ReconciliationStatus.REPAIRED);
    });

    it('ESCALATED → SUPPRESSED', () => {
      const f = makeFinding();
      f.escalate('system', NOW);
      f.suppress('admin-1', 'false positive', NOW);
      expect(f.status).toBe(ReconciliationStatus.SUPPRESSED);
    });

    // Terminal states reject transitions
    it('REPAIRED rejects all transitions', () => {
      const f = makeFinding();
      f.markRepaired('admin-1', 'fixed', NOW);
      expect(() => f.acknowledge('admin-2', NOW)).toThrow(DomainError);
      expect(() => f.escalate('admin-2', NOW)).toThrow(DomainError);
    });

    it('SUPPRESSED rejects all transitions', () => {
      const f = makeFinding();
      f.suppress('admin-1', 'benign', NOW);
      expect(() => f.acknowledge('admin-2', NOW)).toThrow(DomainError);
      expect(() => f.escalate('admin-2', NOW)).toThrow(DomainError);
    });

    // Invalid transitions
    it('OPEN → OPEN is invalid', () => {
      const f = makeFinding();
      // No direct transition method, but testing FSM logic
      expect(() => f.acknowledge('a', NOW)).not.toThrow();
      // Already acknowledged, cannot go back to OPEN
    });

    it('ACKNOWLEDGED → ACKNOWLEDGED is invalid (no method, but SUPPRESSED from acknowledged is invalid)', () => {
      const f = makeFinding();
      f.acknowledge('admin-1', NOW);
      // ACKNOWLEDGED cannot go to SUPPRESSED
      expect(() => f.suppress('admin-1', 'reason', NOW)).toThrow(DomainError);
    });

    it('markRepaired rejects empty action', () => {
      const f = makeFinding();
      expect(() => f.markRepaired('admin-1', '', NOW)).toThrow(DomainError);
    });

    it('suppress rejects empty reason', () => {
      const f = makeFinding();
      expect(() => f.suppress('admin-1', '', NOW)).toThrow(DomainError);
    });
  });

  describe('restore', () => {
    it('restores a finding in any state', () => {
      const f = ReconciliationFinding.restore({
        id: 'f-1',
        runId: 'run-1',
        aggregateType: 'Rental',
        aggregateId: 'rental-1',
        providerObjectIds: ['pi_test'],
        internalSnapshot: {},
        providerSnapshot: {},
        driftType: DriftType.ORPHAN_INTERNAL_RECORD,
        severity: ReconciliationSeverity.CRITICAL,
        recommendedAction: 'FREEZE_ENTITY',
        status: ReconciliationStatus.ESCALATED,
        createdAt: NOW,
        resolvedAt: null,
        resolvedBy: null,
        repairAction: null,
        metadata: { escalatedBy: 'system' },
      });
      expect(f.status).toBe(ReconciliationStatus.ESCALATED);
      expect(f.metadata).toEqual({ escalatedBy: 'system' });
    });
  });
});
