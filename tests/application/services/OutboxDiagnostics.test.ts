import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxDiagnosticsService } from '../../../src/application/services/OutboxDiagnosticsService';
import { InMemoryOutboxRepository } from '../../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { OutboxEvent } from '../../../src/domain/entities/OutboxEvent';

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

describe('OutboxDiagnosticsService', () => {
  let repo: InMemoryOutboxRepository;
  let service: OutboxDiagnosticsService;

  beforeEach(() => {
    repo = new InMemoryOutboxRepository();
    service = new OutboxDiagnosticsService(repo);
  });

  it('returns status counts', async () => {
    await repo.create(makeEvent('1'));
    await repo.create(makeEvent('2'));
    const e3 = makeEvent('3');
    await repo.create(e3);
    e3.acquireLease('w', NOW);
    e3.markSucceeded(NOW);
    await repo.save(e3);

    const status = await service.getStatus();
    expect(status.pending).toBe(2);
    expect(status.succeeded).toBe(1);
  });

  it('lists dead letters', async () => {
    const event = makeEvent('1');
    await repo.create(event);
    event.acquireLease('w', NOW);
    event.markFailed(NOW, 'permanent', true);
    await repo.save(event);

    const deadLetters = await service.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].id).toBe('1');
  });

  it('retries dead-lettered events', async () => {
    const event = makeEvent('1');
    await repo.create(event);
    event.acquireLease('w', NOW);
    event.markFailed(NOW, 'permanent', true);
    await repo.save(event);

    const retried = await service.retryDeadLetter('1');
    expect(retried).not.toBeNull();
    expect(retried!.status).toBe('PENDING');
    expect(retried!.lastError).toBeNull();
  });

  it('returns null when retrying non-existent event', async () => {
    const result = await service.retryDeadLetter('nonexistent');
    expect(result).toBeNull();
  });

  it('finds events by aggregate', async () => {
    await repo.create(makeEvent('1'));
    await repo.create(makeEvent('2'));

    const events = await service.findByAggregate('Rental', 'rental-1');
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('1');
  });

  it('finds events by topic and status', async () => {
    await repo.create(makeEvent('1', 'payment.capture'));
    await repo.create(makeEvent('2', 'payment.refund'));

    const captures = await service.findByTopicAndStatus('payment.capture', 'PENDING');
    expect(captures).toHaveLength(1);
    expect(captures[0].topic).toBe('payment.capture');
  });

  it('finds event by id', async () => {
    await repo.create(makeEvent('1'));
    const event = await service.findEvent('1');
    expect(event).not.toBeNull();
    expect(event!.id).toBe('1');
  });
});
