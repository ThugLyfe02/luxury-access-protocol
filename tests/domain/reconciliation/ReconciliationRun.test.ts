import { describe, it, expect } from 'vitest';
import { ReconciliationRun } from '../../../src/domain/entities/ReconciliationRun';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';
import { DomainError } from '../../../src/domain/errors/DomainError';

const NOW = new Date('2025-06-01T00:00:00Z');
const LATER = new Date('2025-06-01T00:05:00Z');

function makeRun(): ReconciliationRun {
  return ReconciliationRun.create({
    id: 'run-1',
    triggeredBy: 'test-actor',
    startedAt: NOW,
  });
}

describe('ReconciliationRun', () => {
  describe('create', () => {
    it('creates in RUNNING state with zero counters', () => {
      const run = makeRun();
      expect(run.status).toBe('RUNNING');
      expect(run.completedAt).toBeNull();
      expect(run.error).toBeNull();
      expect(run.summary.totalChecked).toBe(0);
      expect(run.summary.totalFindings).toBe(0);
      expect(run.summary.repairedCount).toBe(0);
      expect(run.summary.escalatedCount).toBe(0);
      expect(run.summary.failedChecks).toBe(0);
    });

    it('rejects empty ID', () => {
      expect(() => ReconciliationRun.create({ id: '', triggeredBy: 'x', startedAt: NOW })).toThrow(DomainError);
    });

    it('rejects empty triggeredBy', () => {
      expect(() => ReconciliationRun.create({ id: 'r-1', triggeredBy: '', startedAt: NOW })).toThrow(DomainError);
    });
  });

  describe('counters', () => {
    it('records checked', () => {
      const run = makeRun();
      run.recordChecked();
      run.recordChecked();
      expect(run.summary.totalChecked).toBe(2);
    });

    it('records findings by severity', () => {
      const run = makeRun();
      run.recordFinding(ReconciliationSeverity.CRITICAL);
      run.recordFinding(ReconciliationSeverity.CRITICAL);
      run.recordFinding(ReconciliationSeverity.HIGH);
      expect(run.summary.totalFindings).toBe(3);
      expect(run.summary.findingsBySeverity[ReconciliationSeverity.CRITICAL]).toBe(2);
      expect(run.summary.findingsBySeverity[ReconciliationSeverity.HIGH]).toBe(1);
    });

    it('records repairs', () => {
      const run = makeRun();
      run.recordRepair();
      expect(run.summary.repairedCount).toBe(1);
    });

    it('records escalations', () => {
      const run = makeRun();
      run.recordEscalation();
      expect(run.summary.escalatedCount).toBe(1);
    });

    it('records failed checks', () => {
      const run = makeRun();
      run.recordFailedCheck();
      run.recordFailedCheck();
      expect(run.summary.failedChecks).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('completes successfully', () => {
      const run = makeRun();
      run.complete(LATER);
      expect(run.status).toBe('COMPLETED');
      expect(run.completedAt).toBe(LATER);
      expect(run.error).toBeNull();
    });

    it('fails with error message', () => {
      const run = makeRun();
      run.fail('database timeout', LATER);
      expect(run.status).toBe('FAILED');
      expect(run.completedAt).toBe(LATER);
      expect(run.error).toBe('database timeout');
    });

    it('rejects completing a completed run', () => {
      const run = makeRun();
      run.complete(LATER);
      expect(() => run.complete(LATER)).toThrow(DomainError);
    });

    it('rejects failing a completed run', () => {
      const run = makeRun();
      run.complete(LATER);
      expect(() => run.fail('oops', LATER)).toThrow(DomainError);
    });

    it('rejects completing a failed run', () => {
      const run = makeRun();
      run.fail('error', LATER);
      expect(() => run.complete(LATER)).toThrow(DomainError);
    });
  });

  describe('restore', () => {
    it('restores a completed run with counters', () => {
      const run = ReconciliationRun.restore({
        id: 'run-2',
        triggeredBy: 'admin',
        startedAt: NOW,
        status: 'COMPLETED',
        completedAt: LATER,
        totalChecked: 50,
        totalFindings: 3,
        findingsBySeverity: { CRITICAL: 1, HIGH: 2 },
        repairedCount: 1,
        escalatedCount: 1,
        failedChecks: 0,
        error: null,
      });
      expect(run.status).toBe('COMPLETED');
      expect(run.summary.totalChecked).toBe(50);
      expect(run.summary.totalFindings).toBe(3);
    });
  });
});
