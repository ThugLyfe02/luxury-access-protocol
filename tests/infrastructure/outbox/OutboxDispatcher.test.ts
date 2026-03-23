import { describe, it, expect, vi } from 'vitest';
import { OutboxDispatcher } from '../../../src/infrastructure/outbox/OutboxDispatcher';

describe('OutboxDispatcher', () => {
  it('registers and retrieves handlers', () => {
    const dispatcher = new OutboxDispatcher();
    const handler = { handle: vi.fn() };
    dispatcher.register('payment.capture', handler);

    expect(dispatcher.hasHandler('payment.capture')).toBe(true);
    expect(dispatcher.getHandler('payment.capture')).toBe(handler);
  });

  it('throws for unregistered topic', () => {
    const dispatcher = new OutboxDispatcher();
    expect(() => dispatcher.getHandler('payment.capture')).toThrow('No handler registered');
  });

  it('lists registered topics', () => {
    const dispatcher = new OutboxDispatcher();
    dispatcher.register('payment.capture', { handle: vi.fn() });
    dispatcher.register('payment.refund', { handle: vi.fn() });

    expect(dispatcher.registeredTopics).toContain('payment.capture');
    expect(dispatcher.registeredTopics).toContain('payment.refund');
    expect(dispatcher.registeredTopics).toHaveLength(2);
  });

  it('reports hasHandler correctly', () => {
    const dispatcher = new OutboxDispatcher();
    expect(dispatcher.hasHandler('payment.capture')).toBe(false);
    dispatcher.register('payment.capture', { handle: vi.fn() });
    expect(dispatcher.hasHandler('payment.capture')).toBe(true);
  });
});
