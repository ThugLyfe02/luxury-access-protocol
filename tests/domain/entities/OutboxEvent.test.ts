import { describe, it, expect } from 'vitest';
import { OutboxEvent } from '../../../src/domain/entities/OutboxEvent';
import { DomainError } from '../../../src/domain/errors/DomainError';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeEvent(overrides?: Partial<Parameters<typeof OutboxEvent.create>[0]>): OutboxEvent {
  return OutboxEvent.create({
    id: 'evt-1',
    topic: 'payment.capture',
    aggregateType: 'Rental',
    aggregateId: 'rental-1',
    payload: { paymentIntentId: 'pi_123' },
    dedupKey: 'capture:rental-1',
    createdAt: NOW,
    ...overrides,
  });
}

describe('OutboxEvent', () => {
  describe('create', () => {
    it('creates an event in PENDING status', () => {
      const event = makeEvent();
      expect(event.status).toBe('PENDING');
      expect(event.attemptCount).toBe(0);
      expect(event.lockedAt).toBeNull();
      expect(event.lockedBy).toBeNull();
      expect(event.lastError).toBeNull();
      expect(event.result).toBeNull();
      expect(event.maxAttempts).toBe(5);
    });

    it('freezes the payload', () => {
      const event = makeEvent();
      expect(Object.isFrozen(event.payload)).toBe(true);
    });

    it('uses custom maxAttempts', () => {
      const event = makeEvent({ maxAttempts: 3 });
      expect(event.maxAttempts).toBe(3);
    });

    it('rejects missing id', () => {
      expect(() => makeEvent({ id: '' })).toThrow(DomainError);
    });

    it('rejects missing topic', () => {
      expect(() => makeEvent({ topic: '' as any })).toThrow(DomainError);
    });

    it('rejects missing aggregateId', () => {
      expect(() => makeEvent({ aggregateId: '' })).toThrow(DomainError);
    });

    it('rejects missing dedupKey', () => {
      expect(() => makeEvent({ dedupKey: '' })).toThrow(DomainError);
    });
  });

  describe('acquireLease', () => {
    it('transitions PENDING → PROCESSING', () => {
      const event = makeEvent();
      const leaseTime = new Date('2025-06-01T00:01:00Z');
      event.acquireLease('worker-1', leaseTime);

      expect(event.status).toBe('PROCESSING');
      expect(event.lockedAt).toEqual(leaseTime);
      expect(event.lockedBy).toBe('worker-1');
      expect(event.attemptCount).toBe(1);
    });

    it('rejects lease on non-PENDING event', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      expect(() => event.acquireLease('worker-2', NOW)).toThrow(DomainError);
    });
  });

  describe('markSucceeded', () => {
    it('transitions PROCESSING → SUCCEEDED', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.markSucceeded(NOW, { transferId: 'tr_123' });

      expect(event.status).toBe('SUCCEEDED');
      expect(event.lockedAt).toBeNull();
      expect(event.lockedBy).toBeNull();
      expect(event.result).toEqual({ transferId: 'tr_123' });
      expect(event.isTerminal()).toBe(true);
    });

    it('freezes the result', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.markSucceeded(NOW, { data: 'test' });
      expect(Object.isFrozen(event.result)).toBe(true);
    });

    it('rejects on non-PROCESSING event', () => {
      const event = makeEvent();
      expect(() => event.markSucceeded(NOW)).toThrow(DomainError);
    });
  });

  describe('markFailed', () => {
    it('transitions PROCESSING → PENDING on retryable failure', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.markFailed(NOW, 'network error', false);

      expect(event.status).toBe('PENDING');
      expect(event.lastError).toBe('network error');
      expect(event.lockedAt).toBeNull();
      expect(event.lockedBy).toBeNull();
    });

    it('applies exponential backoff on retry', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.markFailed(NOW, 'timeout', false);

      // After 1 attempt: backoff = 2^1 * 1000 = 2000ms
      const expectedAvailableAt = new Date(NOW.getTime() + 2000);
      expect(event.availableAt).toEqual(expectedAvailableAt);
    });

    it('transitions PROCESSING → DEAD_LETTER on permanent failure', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.markFailed(NOW, 'card_declined', true);

      expect(event.status).toBe('DEAD_LETTER');
      expect(event.isTerminal()).toBe(true);
    });

    it('transitions to DEAD_LETTER when max attempts reached', () => {
      const event = makeEvent({ maxAttempts: 2 });
      // Attempt 1
      event.acquireLease('worker-1', NOW);
      event.markFailed(NOW, 'error 1', false);
      // Attempt 2
      event.acquireLease('worker-1', new Date(NOW.getTime() + 10000));
      event.markFailed(new Date(NOW.getTime() + 10000), 'error 2', false);

      expect(event.status).toBe('DEAD_LETTER');
      expect(event.attemptCount).toBe(2);
    });

    it('rejects on non-PROCESSING event', () => {
      const event = makeEvent();
      expect(() => event.markFailed(NOW, 'error', false)).toThrow(DomainError);
    });
  });

  describe('releaseStaleLease', () => {
    it('transitions PROCESSING → PENDING', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.releaseStaleLease(new Date(NOW.getTime() + 120000));

      expect(event.status).toBe('PENDING');
      expect(event.lockedAt).toBeNull();
      expect(event.lockedBy).toBeNull();
      expect(event.lastError).toBe('Lease released: worker timed out');
    });

    it('rejects on non-PROCESSING event', () => {
      const event = makeEvent();
      expect(() => event.releaseStaleLease(NOW)).toThrow(DomainError);
    });
  });

  describe('retryFromDeadLetter', () => {
    it('transitions DEAD_LETTER → PENDING', () => {
      const event = makeEvent();
      event.acquireLease('worker-1', NOW);
      event.markFailed(NOW, 'permanent error', true);
      expect(event.status).toBe('DEAD_LETTER');

      const retryTime = new Date(NOW.getTime() + 300000);
      event.retryFromDeadLetter(retryTime);

      expect(event.status).toBe('PENDING');
      expect(event.availableAt).toEqual(retryTime);
      expect(event.lastError).toBeNull();
    });

    it('rejects on non-DEAD_LETTER event', () => {
      const event = makeEvent();
      expect(() => event.retryFromDeadLetter(NOW)).toThrow(DomainError);
    });
  });

  describe('restore', () => {
    it('restores an event from persistence', () => {
      const event = OutboxEvent.restore({
        id: 'evt-restored',
        topic: 'payment.refund',
        aggregateType: 'Rental',
        aggregateId: 'rental-2',
        payload: { paymentIntentId: 'pi_456' },
        dedupKey: 'refund:rental-2',
        status: 'PROCESSING',
        attemptCount: 3,
        maxAttempts: 5,
        availableAt: NOW,
        lockedAt: NOW,
        lockedBy: 'worker-2',
        lastError: 'previous error',
        createdAt: NOW,
        updatedAt: NOW,
        result: null,
      });

      expect(event.id).toBe('evt-restored');
      expect(event.status).toBe('PROCESSING');
      expect(event.attemptCount).toBe(3);
      expect(event.lockedBy).toBe('worker-2');
    });
  });
});
