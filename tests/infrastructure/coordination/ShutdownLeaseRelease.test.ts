import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxWorker } from '../../../src/infrastructure/outbox/OutboxWorker';
import { OutboxDispatcher } from '../../../src/infrastructure/outbox/OutboxDispatcher';
import { OutboxEvent } from '../../../src/domain/entities/OutboxEvent';
import { InMemoryOutboxRepository } from '../../../src/infrastructure/repositories/InMemoryOutboxRepository';

describe('Shutdown Lease Release', () => {
  let repo: InMemoryOutboxRepository;
  let dispatcher: OutboxDispatcher;

  beforeEach(() => {
    repo = new InMemoryOutboxRepository();
    dispatcher = new OutboxDispatcher();
  });

  it('releaseAllLeases returns PROCESSING events to PENDING', async () => {
    // Create events and simulate leasing
    const event1 = OutboxEvent.create({
      id: 'evt-shutdown-1',
      topic: 'payment.capture',
      aggregateType: 'Rental',
      aggregateId: 'rental-1',
      payload: {},
      dedupKey: 'dedup-shutdown-1',
    });
    const event2 = OutboxEvent.create({
      id: 'evt-shutdown-2',
      topic: 'payment.refund',
      aggregateType: 'Rental',
      aggregateId: 'rental-2',
      payload: {},
      dedupKey: 'dedup-shutdown-2',
    });

    await repo.create(event1);
    await repo.create(event2);

    // Lease them (simulates what pollOnce does)
    const worker = new OutboxWorker(repo, dispatcher, {
      workerId: 'my-worker',
      batchSize: 10,
      pollIntervalMs: 1000,
      staleLeaseThresholdMs: 60_000,
    });

    const leased = await repo.leaseNextBatch('my-worker', 10, new Date());
    expect(leased).toHaveLength(2);
    expect(leased[0].status).toBe('PROCESSING');

    // Now release all leases
    const released = await worker.releaseAllLeases();

    expect(released).toBe(2);

    // Verify events are back to PENDING
    const e1 = await repo.findById('evt-shutdown-1');
    const e2 = await repo.findById('evt-shutdown-2');
    expect(e1!.status).toBe('PENDING');
    expect(e2!.status).toBe('PENDING');
    expect(e1!.lockedBy).toBeNull();
    expect(e2!.lockedBy).toBeNull();
  });

  it('does not release events locked by other workers', async () => {
    const event1 = OutboxEvent.create({
      id: 'evt-other-1',
      topic: 'payment.capture',
      aggregateType: 'Rental',
      aggregateId: 'rental-1',
      payload: {},
      dedupKey: 'dedup-other-1',
    });
    const event2 = OutboxEvent.create({
      id: 'evt-other-2',
      topic: 'payment.refund',
      aggregateType: 'Rental',
      aggregateId: 'rental-2',
      payload: {},
      dedupKey: 'dedup-other-2',
    });

    await repo.create(event1);
    await repo.create(event2);

    // Lease by different worker
    await repo.leaseNextBatch('other-worker', 10, new Date());

    // My worker tries to release — should find nothing
    const worker = new OutboxWorker(repo, dispatcher, {
      workerId: 'my-worker',
      batchSize: 10,
      pollIntervalMs: 1000,
      staleLeaseThresholdMs: 60_000,
    });

    const released = await worker.releaseAllLeases();
    expect(released).toBe(0);

    // Other worker's events still PROCESSING
    const e1 = await repo.findById('evt-other-1');
    expect(e1!.status).toBe('PROCESSING');
    expect(e1!.lockedBy).toBe('other-worker');
  });

  it('returns 0 when no events are processing', async () => {
    const worker = new OutboxWorker(repo, dispatcher, {
      workerId: 'my-worker',
      batchSize: 10,
      pollIntervalMs: 1000,
      staleLeaseThresholdMs: 60_000,
    });

    const released = await worker.releaseAllLeases();
    expect(released).toBe(0);
  });
});
