import { OutboxEvent, OutboxEventTopic } from '../../domain/entities/OutboxEvent';

/**
 * Handler for a specific outbox event topic.
 *
 * Each handler is responsible for executing the external side effect
 * (e.g., calling the payment provider) and returning a result payload.
 *
 * Handlers MUST be idempotent — they may be invoked multiple times
 * for the same event if a prior attempt failed after partial execution.
 */
export interface OutboxEventHandler {
  handle(event: OutboxEvent): Promise<Record<string, unknown>>;
}

/**
 * Dispatches outbox events to topic-specific handlers.
 *
 * Each topic maps to exactly one handler. If no handler is registered
 * for a topic, the dispatcher throws (permanent failure — misconfiguration).
 */
export class OutboxDispatcher {
  private readonly handlers: Map<OutboxEventTopic, OutboxEventHandler> = new Map();

  register(topic: OutboxEventTopic, handler: OutboxEventHandler): void {
    this.handlers.set(topic, handler);
  }

  getHandler(topic: OutboxEventTopic): OutboxEventHandler {
    const handler = this.handlers.get(topic);
    if (!handler) {
      throw new Error(`No handler registered for outbox topic: ${topic}`);
    }
    return handler;
  }

  hasHandler(topic: OutboxEventTopic): boolean {
    return this.handlers.has(topic);
  }

  get registeredTopics(): OutboxEventTopic[] {
    return Array.from(this.handlers.keys());
  }
}
