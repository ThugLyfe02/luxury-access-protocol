import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOutboxRepository } from '../../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { OutboxEvent } from '../../../src/domain/entities/OutboxEvent';
import { DomainError } from '../../../src/domain/errors/DomainError';

const NOW = new Date('2025-06-01T00:00:00Z');
const LATER = new Date('2025-06-01T00:05:00Z');

function makeEvent(id: string, overrides?: Partial<Parameters<typeof OutboxEvent.create>[0]>): OutboxEvent {
  return OutboxEvent.create({
    id,
    topic: 'payment.capture',
    aggregateType: 'Rental',
    aggregateId: `rental-${id}`,
    payload: { paymentIntentId: `pi_${id}` },
    dedupKey: `capture:${id}`,
    createdAt: NOW,
    ...overrides,
  });
}

describe('InMemoryOutboxRepository', () => {
  let repo: InMemoryOutboxRepository;

  beforeEach(() => {
    repo = new InMemoryOutboxRepository();
  });

  describe('create', () => {
    it('persists an event', async () => {
      const event = makeEvent('1');
      await repo.create(event);
      const found = await repo.findById('1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('1');
    });

    it('rejects duplicate dedup keys', async () => {
      const event1 = makeEvent('1');
      const event2 = makeEvent('2', { dedupKey: 'capture:1' });
      await repo.create(event1);
      await expect(repo.create(event2)).rejects.toThrow(DomainError);
    });
  });

  describe('findByDedupKey', () => {
    it('finds event by dedup key', async () => {
      const event = makeEvent('1');
      await repo.create(event);
      const found = await repo.findByDedupKey('capture:1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('1');
    });

    it('returns null for unknown dedup key', async () => {
      const found = await repo.findByDedupKey('unknown');
      expect(found).toBeNull();
    });
  });

  describe('leaseNextBatch', () => {
    it('leases PENDING events whose availableAt <= now', async () => {
      await repo.create(makeEvent('1'));
      await repo.create(makeEvent('2'));
      await repo.create(makeEvent('3'));

      const leased = await repo.leaseNextBatch('worker-1', 2, NOW);
      expect(leased).toHaveLength(2);
      expect(leased[0].status).toBe('PROCESSING');
      expect(leased[0].lockedBy).toBe('worker-1');
    });

    it('respects batch size', async () => {
      await repo.create(makeEvent('1'));
      await repo.create(makeEvent('2'));
      await repo.create(makeEvent('3'));

      const leased = await repo.leaseNextBatch('worker-1', 1, NOW);
      expect(leased).toHaveLength(1);
    });

    it('skips events with future availableAt', async () => {
      const futureEvent = makeEvent('1', { createdAt: LATER });
      await repo.create(futureEvent);
      // The event was created with availableAt = LATER
      const leased = await repo.leaseNextBatch('worker-1', 10, NOW);
      expect(leased).toHaveLength(0);
    });

    it('skips non-PENDING events', async () => {
      const event = makeEvent('1');
      await repo.create(event);
      event.acquireLease('worker-1', NOW);
      await repo.save(event);

      const leased = await repo.leaseNextBatch('worker-2', 10, NOW);
      expect(leased).toHaveLength(0);
    });
  });

  describe('save', () => {
    it('updates event state', async () => {
      const event = makeEvent('1');
      await repo.create(event);
      event.acquireLease('worker-1', NOW);
      event.markSucceeded(NOW, { result: 'ok' });
      await repo.save(event);

      const found = await repo.findById('1');
      expect(found!.status).toBe('SUCCEEDED');
    });

    it('rejects save for unknown events', async () => {
      const event = makeEvent('unknown');
      await expect(repo.save(event)).rejects.toThrow(DomainError);
    });
  });

  describe('findStaleLeases', () => {
    it('finds PROCESSING events with old locks', async () => {
      const event = makeEvent('1');
      await repo.create(event);
      event.acquireLease('worker-1', NOW);
      await repo.save(event);

      const stale = await repo.findStaleLeases(LATER);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('1');
    });

    it('excludes events locked recently', async () => {
      const event = makeEvent('1');
      await repo.create(event);
      event.acquireLease('worker-1', LATER);
      await repo.save(event);

      const stale = await repo.findStaleLeases(NOW);
      expect(stale).toHaveLength(0);
    });
  });

  describe('findByStatus', () => {
    it('returns events filtered by status', async () => {
      const e1 = makeEvent('1');
      const e2 = makeEvent('2');
      await repo.create(e1);
      await repo.create(e2);
      e1.acquireLease('worker-1', NOW);
      e1.markSucceeded(NOW);
      await repo.save(e1);

      const pending = await repo.findByStatus('PENDING', 10);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('2');

      const succeeded = await repo.findByStatus('SUCCEEDED', 10);
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0].id).toBe('1');
    });
  });

  describe('findByAggregate', () => {
    it('returns events for a specific aggregate', async () => {
      await repo.create(makeEvent('1', { aggregateType: 'Rental', aggregateId: 'rental-A' }));
      await repo.create(makeEvent('2', { aggregateType: 'Rental', aggregateId: 'rental-B' }));
      await repo.create(makeEvent('3', { aggregateType: 'Rental', aggregateId: 'rental-A', dedupKey: 'refund:A' }));

      const events = await repo.findByAggregate('Rental', 'rental-A');
      expect(events).toHaveLength(2);
    });
  });

  describe('findByTopicAndStatus', () => {
    it('filters by topic and status', async () => {
      await repo.create(makeEvent('1', { topic: 'payment.capture' }));
      await repo.create(makeEvent('2', { topic: 'payment.refund', dedupKey: 'refund:2' }));

      const captures = await repo.findByTopicAndStatus('payment.capture', 'PENDING', 10);
      expect(captures).toHaveLength(1);
      expect(captures[0].topic).toBe('payment.capture');
    });
  });

  describe('diagnostics', () => {
    it('returns correct counts', async () => {
      const e1 = makeEvent('1');
      const e2 = makeEvent('2');
      const e3 = makeEvent('3');
      await repo.create(e1);
      await repo.create(e2);
      await repo.create(e3);

      e1.acquireLease('worker-1', NOW);
      e1.markSucceeded(NOW);
      await repo.save(e1);

      e2.acquireLease('worker-1', NOW);
      e2.markFailed(NOW, 'permanent', true);
      await repo.save(e2);

      const diag = await repo.diagnostics();
      expect(diag.pending).toBe(1);
      expect(diag.succeeded).toBe(1);
      expect(diag.deadLetter).toBe(1);
      expect(diag.processing).toBe(0);
      expect(diag.failed).toBe(0);
    });
  });
});
