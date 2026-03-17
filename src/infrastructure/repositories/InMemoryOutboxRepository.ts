import { OutboxEvent, OutboxEventStatus, OutboxEventTopic } from '../../domain/entities/OutboxEvent';
import { OutboxRepository, OutboxDiagnostics } from '../../domain/interfaces/OutboxRepository';
import { DomainError } from '../../domain/errors/DomainError';

/**
 * In-memory outbox repository for tests.
 * Not suitable for production — events are lost on restart.
 */
export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly events: Map<string, OutboxEvent> = new Map();
  private readonly dedupIndex: Map<string, string> = new Map(); // dedupKey → eventId

  async create(event: OutboxEvent): Promise<void> {
    if (this.dedupIndex.has(event.dedupKey)) {
      throw new DomainError(
        `Duplicate outbox dedup key: ${event.dedupKey}`,
        'DUPLICATE_REQUEST',
      );
    }
    this.events.set(event.id, event);
    this.dedupIndex.set(event.dedupKey, event.id);
  }

  async findById(id: string): Promise<OutboxEvent | null> {
    return this.events.get(id) ?? null;
  }

  async findByDedupKey(dedupKey: string): Promise<OutboxEvent | null> {
    const eventId = this.dedupIndex.get(dedupKey);
    if (!eventId) return null;
    return this.events.get(eventId) ?? null;
  }

  async leaseNextBatch(workerId: string, batchSize: number, now: Date): Promise<OutboxEvent[]> {
    const pending: OutboxEvent[] = [];

    for (const event of this.events.values()) {
      if (event.status === 'PENDING' && event.availableAt <= now) {
        pending.push(event);
      }
    }

    // Sort by availableAt (oldest first) for fairness
    pending.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());

    const batch = pending.slice(0, batchSize);
    for (const event of batch) {
      event.acquireLease(workerId, now);
    }

    return batch;
  }

  async save(event: OutboxEvent): Promise<void> {
    if (!this.events.has(event.id)) {
      throw new DomainError(`Outbox event not found: ${event.id}`, 'INVALID_STATE_TRANSITION');
    }
    this.events.set(event.id, event);
  }

  async findStaleLeases(olderThan: Date): Promise<OutboxEvent[]> {
    const stale: OutboxEvent[] = [];
    for (const event of this.events.values()) {
      if (
        event.status === 'PROCESSING' &&
        event.lockedAt !== null &&
        event.lockedAt < olderThan
      ) {
        stale.push(event);
      }
    }
    return stale;
  }

  async findByStatus(status: OutboxEventStatus, limit: number): Promise<OutboxEvent[]> {
    const matches: OutboxEvent[] = [];
    for (const event of this.events.values()) {
      if (event.status === status) {
        matches.push(event);
      }
    }
    matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches.slice(0, limit);
  }

  async findByAggregate(aggregateType: string, aggregateId: string): Promise<OutboxEvent[]> {
    const matches: OutboxEvent[] = [];
    for (const event of this.events.values()) {
      if (event.aggregateType === aggregateType && event.aggregateId === aggregateId) {
        matches.push(event);
      }
    }
    matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches;
  }

  async findByTopicAndStatus(topic: OutboxEventTopic, status: OutboxEventStatus, limit: number): Promise<OutboxEvent[]> {
    const matches: OutboxEvent[] = [];
    for (const event of this.events.values()) {
      if (event.topic === topic && event.status === status) {
        matches.push(event);
      }
    }
    matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matches.slice(0, limit);
  }

  async diagnostics(): Promise<OutboxDiagnostics> {
    let pending = 0, processing = 0, succeeded = 0, failed = 0, deadLetter = 0;
    for (const event of this.events.values()) {
      switch (event.status) {
        case 'PENDING': pending++; break;
        case 'PROCESSING': processing++; break;
        case 'SUCCEEDED': succeeded++; break;
        case 'FAILED': failed++; break;
        case 'DEAD_LETTER': deadLetter++; break;
      }
    }
    return { pending, processing, succeeded, failed, deadLetter };
  }
}
