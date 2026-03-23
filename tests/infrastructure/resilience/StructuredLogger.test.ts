import { describe, it, expect } from 'vitest';
import { StructuredLogger, InMemoryLogSink } from '../../../src/infrastructure/resilience/StructuredLogger';

describe('StructuredLogger', () => {
  it('writes structured log entries', () => {
    const sink = new InMemoryLogSink();
    const logger = new StructuredLogger(sink);

    logger.info('test message', { requestId: 'req-1' });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0].level).toBe('info');
    expect(sink.entries[0].message).toBe('test message');
    expect(sink.entries[0].context.requestId).toBe('req-1');
    expect(sink.entries[0].ts).toBeDefined();
  });

  it('supports warn and error levels', () => {
    const sink = new InMemoryLogSink();
    const logger = new StructuredLogger(sink);

    logger.warn('warning');
    logger.error('error');

    expect(sink.entries[0].level).toBe('warn');
    expect(sink.entries[1].level).toBe('error');
  });

  it('merges base context with per-call context', () => {
    const sink = new InMemoryLogSink();
    const logger = new StructuredLogger(sink, { workerName: 'outbox' });

    logger.info('processing', { outboxEventId: 'evt-1' });

    expect(sink.entries[0].context.workerName).toBe('outbox');
    expect(sink.entries[0].context.outboxEventId).toBe('evt-1');
  });

  it('creates child loggers with inherited context', () => {
    const sink = new InMemoryLogSink();
    const parent = new StructuredLogger(sink, { workerName: 'outbox' });
    const child = parent.child({ aggregateId: 'rental-1' });

    child.info('child message', { operation: 'capture' });

    expect(sink.entries[0].context.workerName).toBe('outbox');
    expect(sink.entries[0].context.aggregateId).toBe('rental-1');
    expect(sink.entries[0].context.operation).toBe('capture');
  });

  it('child context overrides parent context', () => {
    const sink = new InMemoryLogSink();
    const parent = new StructuredLogger(sink, { workerName: 'parent' });
    const child = parent.child({ workerName: 'child' });

    child.info('test');
    expect(sink.entries[0].context.workerName).toBe('child');
  });

  it('InMemoryLogSink clears entries', () => {
    const sink = new InMemoryLogSink();
    const logger = new StructuredLogger(sink);
    logger.info('a');
    logger.info('b');
    expect(sink.entries).toHaveLength(2);
    sink.clear();
    expect(sink.entries).toHaveLength(0);
  });
});
