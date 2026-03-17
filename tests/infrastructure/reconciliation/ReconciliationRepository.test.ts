import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryReconciliationRepository } from '../../../src/infrastructure/repositories/InMemoryReconciliationRepository';
import { ReconciliationFinding } from '../../../src/domain/entities/ReconciliationFinding';
import { ReconciliationRun } from '../../../src/domain/entities/ReconciliationRun';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../../src/domain/enums/ReconciliationStatus';

const NOW = new Date('2025-06-01T00:00:00Z');
const LATER = new Date('2025-06-01T01:00:00Z');

function makeFinding(overrides: Partial<{
  id: string;
  aggregateId: string;
  driftType: DriftType;
  severity: ReconciliationSeverity;
  providerObjectIds: string[];
}> = {}): ReconciliationFinding {
  return ReconciliationFinding.create({
    id: overrides.id ?? 'finding-1',
    runId: 'run-1',
    aggregateType: 'Rental',
    aggregateId: overrides.aggregateId ?? 'rental-1',
    providerObjectIds: overrides.providerObjectIds ?? ['pi_test'],
    internalSnapshot: {},
    providerSnapshot: {},
    driftType: overrides.driftType ?? DriftType.ORPHAN_INTERNAL_RECORD,
    severity: overrides.severity ?? ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    createdAt: NOW,
  });
}

describe('InMemoryReconciliationRepository', () => {
  let repo: InMemoryReconciliationRepository;

  beforeEach(() => {
    repo = new InMemoryReconciliationRepository();
  });

  describe('runs', () => {
    it('creates and retrieves a run', async () => {
      const run = ReconciliationRun.create({ id: 'run-1', triggeredBy: 'test', startedAt: NOW });
      await repo.createRun(run);
      const found = await repo.findRunById('run-1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('run-1');
    });

    it('saves run updates', async () => {
      const run = ReconciliationRun.create({ id: 'run-1', triggeredBy: 'test', startedAt: NOW });
      await repo.createRun(run);
      run.complete(LATER);
      await repo.saveRun(run);
      const found = await repo.findRunById('run-1');
      expect(found!.status).toBe('COMPLETED');
    });

    it('lists runs sorted by startedAt descending', async () => {
      const run1 = ReconciliationRun.create({ id: 'run-1', triggeredBy: 'test', startedAt: NOW });
      const run2 = ReconciliationRun.create({ id: 'run-2', triggeredBy: 'test', startedAt: LATER });
      await repo.createRun(run1);
      await repo.createRun(run2);
      const runs = await repo.listRuns(10);
      expect(runs[0].id).toBe('run-2');
      expect(runs[1].id).toBe('run-1');
    });

    it('respects limit on listRuns', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.createRun(ReconciliationRun.create({
          id: `run-${i}`,
          triggeredBy: 'test',
          startedAt: new Date(NOW.getTime() + i * 1000),
        }));
      }
      const runs = await repo.listRuns(3);
      expect(runs).toHaveLength(3);
    });
  });

  describe('findings', () => {
    it('creates and retrieves a finding', async () => {
      const f = makeFinding();
      await repo.createFinding(f);
      const found = await repo.findFindingById('finding-1');
      expect(found).not.toBeNull();
      expect(found!.driftType).toBe(DriftType.ORPHAN_INTERNAL_RECORD);
    });

    it('returns null for non-existent finding', async () => {
      const found = await repo.findFindingById('nonexistent');
      expect(found).toBeNull();
    });

    it('finds unresolved findings sorted by severity', async () => {
      const f1 = makeFinding({ id: 'f1', severity: ReconciliationSeverity.LOW, driftType: DriftType.CONNECTED_ACCOUNT_STATE_MISMATCH });
      const f2 = makeFinding({ id: 'f2', severity: ReconciliationSeverity.CRITICAL });
      const f3 = makeFinding({ id: 'f3', severity: ReconciliationSeverity.HIGH, driftType: DriftType.REFUND_STATE_MISMATCH });
      await repo.createFinding(f1);
      await repo.createFinding(f2);
      await repo.createFinding(f3);

      const unresolved = await repo.findUnresolved(10);
      expect(unresolved).toHaveLength(3);
      // CRITICAL first, then HIGH, then LOW
      expect(unresolved[0].severity).toBe(ReconciliationSeverity.CRITICAL);
      expect(unresolved[1].severity).toBe(ReconciliationSeverity.HIGH);
      expect(unresolved[2].severity).toBe(ReconciliationSeverity.LOW);
    });

    it('excludes resolved findings from unresolved query', async () => {
      const f1 = makeFinding({ id: 'f1' });
      const f2 = makeFinding({ id: 'f2' });
      await repo.createFinding(f1);
      await repo.createFinding(f2);

      f1.markRepaired('admin', 'fixed', NOW);
      await repo.saveFinding(f1);

      const unresolved = await repo.findUnresolved(10);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].id).toBe('f2');
    });

    it('finds by severity', async () => {
      const f1 = makeFinding({ id: 'f1', severity: ReconciliationSeverity.HIGH, driftType: DriftType.REFUND_STATE_MISMATCH });
      const f2 = makeFinding({ id: 'f2', severity: ReconciliationSeverity.CRITICAL });
      await repo.createFinding(f1);
      await repo.createFinding(f2);

      const high = await repo.findBySeverity(ReconciliationSeverity.HIGH, 10);
      expect(high).toHaveLength(1);
      expect(high[0].id).toBe('f1');
    });

    it('finds by aggregate', async () => {
      const f1 = makeFinding({ id: 'f1', aggregateId: 'rental-1' });
      const f2 = makeFinding({ id: 'f2', aggregateId: 'rental-2' });
      await repo.createFinding(f1);
      await repo.createFinding(f2);

      const found = await repo.findByAggregate('Rental', 'rental-1');
      expect(found).toHaveLength(1);
      expect(found[0].aggregateId).toBe('rental-1');
    });

    it('finds by provider object ID', async () => {
      const f1 = makeFinding({ id: 'f1', providerObjectIds: ['pi_abc'] });
      const f2 = makeFinding({ id: 'f2', providerObjectIds: ['pi_xyz'] });
      await repo.createFinding(f1);
      await repo.createFinding(f2);

      const found = await repo.findByProviderObjectId('pi_abc');
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('f1');
    });

    it('finds by run ID', async () => {
      const f = makeFinding({ id: 'f1' });
      await repo.createFinding(f);

      const found = await repo.findByRunId('run-1');
      expect(found).toHaveLength(1);
    });

    it('findOpenByAggregateAndDrift returns open finding', async () => {
      const f = makeFinding({ driftType: DriftType.ORPHAN_INTERNAL_RECORD });
      await repo.createFinding(f);

      const found = await repo.findOpenByAggregateAndDrift('Rental', 'rental-1', DriftType.ORPHAN_INTERNAL_RECORD);
      expect(found).not.toBeNull();
      expect(found!.id).toBe('finding-1');
    });

    it('findOpenByAggregateAndDrift returns null for resolved finding', async () => {
      const f = makeFinding({ driftType: DriftType.ORPHAN_INTERNAL_RECORD });
      await repo.createFinding(f);
      f.markRepaired('admin', 'fixed', NOW);
      await repo.saveFinding(f);

      const found = await repo.findOpenByAggregateAndDrift('Rental', 'rental-1', DriftType.ORPHAN_INTERNAL_RECORD);
      expect(found).toBeNull();
    });

    it('findOpenByAggregateAndDrift returns null for different drift type', async () => {
      const f = makeFinding({ driftType: DriftType.ORPHAN_INTERNAL_RECORD });
      await repo.createFinding(f);

      const found = await repo.findOpenByAggregateAndDrift('Rental', 'rental-1', DriftType.REFUND_STATE_MISMATCH);
      expect(found).toBeNull();
    });
  });

  describe('diagnostics', () => {
    it('returns correct diagnostics for mixed state', async () => {
      const f1 = makeFinding({ id: 'f1', severity: ReconciliationSeverity.CRITICAL });
      const f2 = makeFinding({ id: 'f2', severity: ReconciliationSeverity.HIGH, driftType: DriftType.REFUND_STATE_MISMATCH });
      const f3 = makeFinding({ id: 'f3', severity: ReconciliationSeverity.CRITICAL, driftType: DriftType.DUPLICATE_PROVIDER_REFERENCE });
      await repo.createFinding(f1);
      await repo.createFinding(f2);
      await repo.createFinding(f3);

      f2.markRepaired('admin', 'fixed', LATER);
      await repo.saveFinding(f2);

      const run = ReconciliationRun.create({ id: 'run-1', triggeredBy: 'test', startedAt: NOW });
      run.complete(LATER);
      await repo.createRun(run);

      const diag = await repo.diagnostics();
      expect(diag.unresolvedCount).toBe(2);
      expect(diag.repairSuccessCount).toBe(1);
      expect(diag.countBySeverity[ReconciliationSeverity.CRITICAL]).toBe(2);
      expect(diag.countBySeverity[ReconciliationSeverity.HIGH]).toBe(1);
      expect(diag.lastSuccessfulRun).toEqual(LATER);
      expect(diag.oldestUnresolvedFinding).toEqual(NOW);
    });

    it('returns empty diagnostics when no data', async () => {
      const diag = await repo.diagnostics();
      expect(diag.unresolvedCount).toBe(0);
      expect(diag.repairSuccessCount).toBe(0);
      expect(diag.lastSuccessfulRun).toBeNull();
    });
  });
});
