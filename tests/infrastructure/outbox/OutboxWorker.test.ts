import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OutboxWorker } from '../../../src/infrastructure/outbox/OutboxWorker';
import { OutboxDispatcher, OutboxEventHandler } from '../../../src/infrastructure/outbox/OutboxDispatcher';
import { InMemoryOutboxRepository } from '../../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { OutboxEvent } from '../../../src/domain/entities/OutboxEvent';
import { DomainError } from '../../../src/domain/errors/DomainError';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeEvent(id: string, topic: string = 'payment.capture'): OutboxEvent {
  return OutboxEvent.create({
    id,
    topic: topic as any,
    aggregateType: 'Rental',
    aggregateId: `rental-${id}`,
    payload: { paymentIntentId: `pi_${id}` },
    dedupKey: `${topic}:${id}`,
    createdAt: NOW,
  });
}

function makeSuccessHandler(): OutboxEventHandler {
  return {
    handle: vi.fn().mockResolvedValue({ captured: true }),
  };
}

function makeFailingHandler(error: Error): OutboxEventHandler {
  return {
    handle: vi.fn().mockRejectedValue(error),
  };
}

describe('OutboxWorker', () => {
  let repo: InMemoryOutboxRepository;
  let dispatcher: OutboxDispatcher;

  beforeEach(() => {
    repo = new InMemoryOutboxRepository();
    dispatcher = new OutboxDispatcher();
  });

  describe('pollOnce', () => {
    it('processes PENDING events and marks them SUCCEEDED', async () => {
      dispatcher.register('payment.capture', makeSuccessHandler());
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      await repo.create(makeEvent('1'));
      await repo.create(makeEvent('2'));

      const processed = await worker.pollOnce();
      expect(processed).toBe(2);

      const e1 = await repo.findById('1');
      expect(e1!.status).toBe('SUCCEEDED');
      expect(e1!.result).toEqual({ captured: true });

      const e2 = await repo.findById('2');
      expect(e2!.status).toBe('SUCCEEDED');
    });

    it('marks events PENDING with backoff on retryable failure', async () => {
      dispatcher.register('payment.capture', makeFailingHandler(new Error('network timeout')));
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      await repo.create(makeEvent('1'));
      await worker.pollOnce();

      const event = await repo.findById('1');
      expect(event!.status).toBe('PENDING');
      expect(event!.lastError).toBe('network timeout');
      expect(event!.attemptCount).toBe(1);
      // Should have backoff applied
      expect(event!.availableAt.getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('moves events to DEAD_LETTER on permanent failure', async () => {
      const error = new DomainError('card_declined permanently', 'INVALID_STATE_TRANSITION');
      dispatcher.register('payment.capture', makeFailingHandler(error));
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      await repo.create(makeEvent('1'));
      await worker.pollOnce();

      const event = await repo.findById('1');
      expect(event!.status).toBe('DEAD_LETTER');
    });

    it('returns 0 when no PENDING events', async () => {
      dispatcher.register('payment.capture', makeSuccessHandler());
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      const processed = await worker.pollOnce();
      expect(processed).toBe(0);
    });

    it('respects batch size', async () => {
      dispatcher.register('payment.capture', makeSuccessHandler());
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 1,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      await repo.create(makeEvent('1'));
      await repo.create(makeEvent('2'));

      const processed = await worker.pollOnce();
      expect(processed).toBe(1);

      // Second event still pending
      const diag = await repo.diagnostics();
      expect(diag.pending).toBe(1);
      expect(diag.succeeded).toBe(1);
    });
  });

  describe('stale lease recovery', () => {
    it('releases stale leases before polling', async () => {
      dispatcher.register('payment.capture', makeSuccessHandler());
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 30000, // 30 seconds
      });

      // Create event and acquire lease (simulate another worker)
      const event = makeEvent('1');
      await repo.create(event);
      event.acquireLease('dead-worker', NOW);
      await repo.save(event);

      // Poll with a time well past the stale threshold
      const laterTime = new Date(NOW.getTime() + 120000); // 2 minutes later
      // Manually advance — pollOnce uses new Date() internally but stale check uses threshold

      // The stale lease should be released and then picked up
      await worker.pollOnce();

      const found = await repo.findById('1');
      // It should have been released (stale) then re-leased and processed
      expect(found!.status).toBe('SUCCEEDED');
    });
  });

  describe('start/stop', () => {
    it('starts and stops the worker', () => {
      dispatcher.register('payment.capture', makeSuccessHandler());
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      expect(worker.isRunning).toBe(false);
      worker.start();
      expect(worker.isRunning).toBe(true);
      worker.stop();
      expect(worker.isRunning).toBe(false);
    });

    it('is idempotent on start', () => {
      dispatcher.register('payment.capture', makeSuccessHandler());
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      worker.start();
      worker.start(); // Should not throw
      expect(worker.isRunning).toBe(true);
      worker.stop();
    });
  });

  describe('retry lifecycle', () => {
    it('retries event after backoff period expires', async () => {
      let callCount = 0;
      const handler: OutboxEventHandler = {
        handle: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('temporary failure');
          }
          return { captured: true };
        }),
      };

      dispatcher.register('payment.capture', handler);
      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      await repo.create(makeEvent('1'));

      // First attempt — fails
      await worker.pollOnce();
      let event = await repo.findById('1');
      expect(event!.status).toBe('PENDING');
      expect(event!.attemptCount).toBe(1);

      // Second attempt — need to poll with time past backoff
      // The availableAt has backoff applied, so we need a future time
      // Manually override availableAt for testing
      const futureTime = new Date(event!.availableAt.getTime() + 1);
      // leaseNextBatch uses 'now' param, so pass future time
      const leased = await repo.leaseNextBatch('test-worker', 10, futureTime);
      expect(leased).toHaveLength(1);

      // Process manually
      const result = await handler.handle(leased[0]);
      leased[0].markSucceeded(futureTime, result);
      await repo.save(leased[0]);

      event = await repo.findById('1');
      expect(event!.status).toBe('SUCCEEDED');
      expect(event!.attemptCount).toBe(2);
    });

    it('exhausts max attempts and dead-letters', async () => {
      const handler: OutboxEventHandler = {
        handle: vi.fn().mockRejectedValue(new Error('always fails')),
      };
      dispatcher.register('payment.capture', handler);

      const worker = new OutboxWorker(repo, dispatcher, {
        workerId: 'test-worker',
        batchSize: 10,
        pollIntervalMs: 60000,
        staleLeaseThresholdMs: 60000,
      });

      await repo.create(makeEvent('1', 'payment.capture'));

      // Process until dead-lettered (max 5 attempts)
      for (let i = 0; i < 5; i++) {
        const event = await repo.findById('1');
        if (event!.status === 'DEAD_LETTER') break;

        // Advance time past backoff
        const pollTime = new Date(event!.availableAt.getTime() + 1);
        const leased = await repo.leaseNextBatch('test-worker', 10, pollTime);
        if (leased.length === 0) break;

        try {
          await handler.handle(leased[0]);
        } catch {
          leased[0].markFailed(pollTime, 'always fails', false);
          await repo.save(leased[0]);
        }
      }

      const event = await repo.findById('1');
      expect(event!.status).toBe('DEAD_LETTER');
      expect(event!.attemptCount).toBe(5);
    });
  });
});
