import { describe, it, expect, afterEach } from 'vitest';
import {
  setRequestContext,
  getRequestContext,
  clearRequestContext,
  createRequestContext,
} from '../../src/observability/tracing/RequestContext';
import {
  getCurrentCorrelationId,
  getCurrentRequestId,
  getCurrentActorId,
  getCorrelationContext,
} from '../../src/observability/tracing/Correlation';

describe('RequestContext', () => {
  afterEach(() => {
    clearRequestContext();
  });

  it('starts with no context', () => {
    expect(getRequestContext()).toBeNull();
  });

  it('sets and gets context', () => {
    const ctx = createRequestContext('req-1', 'user-1');
    setRequestContext(ctx);
    expect(getRequestContext()).toBe(ctx);
    expect(getRequestContext()!.requestId).toBe('req-1');
    expect(getRequestContext()!.actorId).toBe('user-1');
  });

  it('correlationId defaults to requestId', () => {
    const ctx = createRequestContext('req-1');
    expect(ctx.correlationId).toBe('req-1');
  });

  it('correlationId can be overridden', () => {
    const ctx = createRequestContext('req-1', undefined, 'corr-1');
    expect(ctx.correlationId).toBe('corr-1');
  });

  it('includes startTime', () => {
    const before = Date.now();
    const ctx = createRequestContext('req-1');
    expect(ctx.startTime).toBeGreaterThanOrEqual(before);
    expect(ctx.startTime).toBeLessThanOrEqual(Date.now());
  });

  it('clears context', () => {
    setRequestContext(createRequestContext('req-1'));
    clearRequestContext();
    expect(getRequestContext()).toBeNull();
  });

  it('context survives async operations within same continuation', async () => {
    const ctx = createRequestContext('req-1', 'actor-1');
    setRequestContext(ctx);

    await Promise.resolve();

    expect(getRequestContext()?.requestId).toBe('req-1');
  });
});

describe('Correlation', () => {
  afterEach(() => {
    clearRequestContext();
  });

  it('returns undefined when no context', () => {
    expect(getCurrentCorrelationId()).toBeUndefined();
    expect(getCurrentRequestId()).toBeUndefined();
    expect(getCurrentActorId()).toBeUndefined();
  });

  it('returns values from active context', () => {
    setRequestContext(createRequestContext('req-1', 'actor-1', 'corr-1'));
    expect(getCurrentRequestId()).toBe('req-1');
    expect(getCurrentCorrelationId()).toBe('corr-1');
    expect(getCurrentActorId()).toBe('actor-1');
  });

  it('getCorrelationContext returns empty object when no context', () => {
    expect(getCorrelationContext()).toEqual({});
  });

  it('getCorrelationContext returns full context', () => {
    setRequestContext(createRequestContext('req-1', 'actor-1'));
    const ctx = getCorrelationContext();
    expect(ctx.requestId).toBe('req-1');
    expect(ctx.correlationId).toBe('req-1');
    expect(ctx.actorId).toBe('actor-1');
  });

  it('getCorrelationContext omits actorId when not set', () => {
    setRequestContext(createRequestContext('req-1'));
    const ctx = getCorrelationContext();
    expect(ctx.requestId).toBe('req-1');
    expect('actorId' in ctx).toBe(false);
  });
});
