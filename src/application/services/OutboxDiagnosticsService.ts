import { OutboxRepository, OutboxDiagnostics } from '../../domain/interfaces/OutboxRepository';
import { OutboxEvent, OutboxEventTopic } from '../../domain/entities/OutboxEvent';

/**
 * Application service for outbox observability and admin operations.
 *
 * Provides:
 * - Status dashboard (counts by status)
 * - Dead letter inspection
 * - Manual retry of dead-lettered events
 * - Event lookup by aggregate
 */
export class OutboxDiagnosticsService {
  constructor(private readonly repo: OutboxRepository) {}

  /**
   * Get diagnostic counts by status.
   */
  async getStatus(): Promise<OutboxDiagnostics> {
    return this.repo.diagnostics();
  }

  /**
   * List dead-lettered events for admin inspection.
   */
  async listDeadLetters(limit = 50): Promise<OutboxEvent[]> {
    return this.repo.findByStatus('DEAD_LETTER', limit);
  }

  /**
   * Retry a dead-lettered event. Resets it to PENDING.
   * Returns the updated event, or null if not found.
   */
  async retryDeadLetter(eventId: string): Promise<OutboxEvent | null> {
    const event = await this.repo.findById(eventId);
    if (!event) return null;

    event.retryFromDeadLetter(new Date());
    await this.repo.save(event);
    return event;
  }

  /**
   * Find an event by ID.
   */
  async findEvent(eventId: string): Promise<OutboxEvent | null> {
    return this.repo.findById(eventId);
  }

  /**
   * Find all events for a given aggregate (e.g., all events for a rental).
   */
  async findByAggregate(aggregateType: string, aggregateId: string): Promise<OutboxEvent[]> {
    return this.repo.findByAggregate(aggregateType, aggregateId);
  }

  /**
   * Find events by topic and status.
   */
  async findByTopicAndStatus(topic: OutboxEventTopic, status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER', limit = 50): Promise<OutboxEvent[]> {
    return this.repo.findByTopicAndStatus(topic, status, limit);
  }
}
