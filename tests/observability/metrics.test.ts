import { describe, it, expect, beforeEach } from 'vitest';
import { Counter } from '../../src/observability/metrics/Counter';
import { Gauge } from '../../src/observability/metrics/Gauge';
import { Histogram } from '../../src/observability/metrics/Histogram';
import { MetricsRegistry } from '../../src/observability/metrics/MetricsRegistry';

describe('Counter', () => {
  it('starts at zero', () => {
    const c = new Counter('test_counter');
    expect(c.value).toBe(0);
  });

  it('increments by 1 by default', () => {
    const c = new Counter('test_counter');
    c.increment();
    expect(c.value).toBe(1);
  });

  it('increments by specified amount', () => {
    const c = new Counter('test_counter');
    c.increment(5);
    expect(c.value).toBe(5);
  });

  it('ignores negative increments', () => {
    const c = new Counter('test_counter');
    c.increment(3);
    c.increment(-1);
    expect(c.value).toBe(3);
  });

  it('returns correct snapshot', () => {
    const c = new Counter('test_counter', { route: '/rentals' });
    c.increment(7);
    const snap = c.snapshot();
    expect(snap.name).toBe('test_counter');
    expect(snap.type).toBe('counter');
    expect(snap.labels).toEqual({ route: '/rentals' });
    expect(snap.value).toBe(7);
  });

  it('resets to zero', () => {
    const c = new Counter('test_counter');
    c.increment(10);
    c.reset();
    expect(c.value).toBe(0);
  });
});

describe('Gauge', () => {
  it('starts at zero', () => {
    const g = new Gauge('test_gauge');
    expect(g.value).toBe(0);
  });

  it('sets value directly', () => {
    const g = new Gauge('test_gauge');
    g.set(42);
    expect(g.value).toBe(42);
  });

  it('increments and decrements', () => {
    const g = new Gauge('test_gauge');
    g.increment(5);
    g.decrement(2);
    expect(g.value).toBe(3);
  });

  it('can go negative', () => {
    const g = new Gauge('test_gauge');
    g.decrement(5);
    expect(g.value).toBe(-5);
  });

  it('returns correct snapshot', () => {
    const g = new Gauge('backlog', { component: 'outbox' });
    g.set(100);
    const snap = g.snapshot();
    expect(snap.name).toBe('backlog');
    expect(snap.type).toBe('gauge');
    expect(snap.labels).toEqual({ component: 'outbox' });
    expect(snap.value).toBe(100);
  });
});

describe('Histogram', () => {
  it('records observations and counts', () => {
    const h = new Histogram('latency_ms');
    h.observe(10);
    h.observe(20);
    h.observe(30);
    expect(h.count).toBe(3);
    expect(h.sum).toBe(60);
    expect(h.mean).toBe(20);
  });

  it('tracks min and max', () => {
    const h = new Histogram('latency_ms');
    h.observe(5);
    h.observe(100);
    h.observe(50);
    expect(h.min).toBe(5);
    expect(h.max).toBe(100);
  });

  it('returns 0 for min/max when empty', () => {
    const h = new Histogram('latency_ms');
    expect(h.min).toBe(0);
    expect(h.max).toBe(0);
    expect(h.mean).toBe(0);
  });

  it('bucketing works correctly', () => {
    const h = new Histogram('latency_ms', {}, [10, 50, 100]);
    h.observe(5);   // <= 10, <= 50, <= 100
    h.observe(25);  // <= 50, <= 100
    h.observe(75);  // <= 100
    h.observe(200); // none

    const snap = h.snapshot();
    expect(snap.extra.buckets).toEqual([
      { le: 10, count: 1 },
      { le: 50, count: 2 },
      { le: 100, count: 3 },
    ]);
  });

  it('uses default buckets', () => {
    const h = new Histogram('latency_ms');
    const snap = h.snapshot();
    expect(snap.extra.buckets.length).toBe(8); // [5, 10, 50, 100, 250, 500, 1000, 5000]
  });

  it('returns correct snapshot type', () => {
    const h = new Histogram('latency_ms', { op: 'capture' });
    h.observe(42);
    const snap = h.snapshot();
    expect(snap.type).toBe('histogram');
    expect(snap.labels).toEqual({ op: 'capture' });
    expect(snap.extra.count).toBe(1);
    expect(snap.extra.sum).toBe(42);
  });

  it('resets all state', () => {
    const h = new Histogram('latency_ms');
    h.observe(10);
    h.observe(20);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.sum).toBe(0);
    expect(h.min).toBe(0);
    expect(h.max).toBe(0);
  });
});

describe('MetricsRegistry', () => {
  beforeEach(() => {
    MetricsRegistry.resetForTesting();
  });

  it('is a singleton', () => {
    const a = MetricsRegistry.getInstance();
    const b = MetricsRegistry.getInstance();
    expect(a).toBe(b);
  });

  it('creates and returns counters', () => {
    const r = MetricsRegistry.getInstance();
    const c1 = r.counter('test_counter');
    const c2 = r.counter('test_counter');
    expect(c1).toBe(c2);
    c1.increment();
    expect(c2.value).toBe(1);
  });

  it('differentiates counters by labels', () => {
    const r = MetricsRegistry.getInstance();
    const c1 = r.counter('requests', { route: '/a' });
    const c2 = r.counter('requests', { route: '/b' });
    expect(c1).not.toBe(c2);
    c1.increment();
    expect(c1.value).toBe(1);
    expect(c2.value).toBe(0);
  });

  it('creates gauges and histograms', () => {
    const r = MetricsRegistry.getInstance();
    const g = r.gauge('backlog');
    const h = r.histogram('latency');
    g.set(5);
    h.observe(10);
    expect(g.value).toBe(5);
    expect(h.count).toBe(1);
  });

  it('getSnapshot returns all metrics', () => {
    const r = MetricsRegistry.getInstance();
    r.counter('c1').increment();
    r.gauge('g1').set(42);
    r.histogram('h1').observe(10);

    const snapshot = r.getSnapshot();
    expect(snapshot.length).toBe(3);
    expect(snapshot.find(s => s.name === 'c1')?.value).toBe(1);
    expect(snapshot.find(s => s.name === 'g1')?.value).toBe(42);
    expect(snapshot.find(s => s.name === 'h1')?.value).toBe(10);
  });

  it('reset clears all metric values', () => {
    const r = MetricsRegistry.getInstance();
    r.counter('c1').increment(5);
    r.gauge('g1').set(42);
    r.histogram('h1').observe(10);

    r.reset();

    expect(r.counter('c1').value).toBe(0);
    expect(r.gauge('g1').value).toBe(0);
    expect(r.histogram('h1').count).toBe(0);
  });

  it('label ordering is normalized', () => {
    const r = MetricsRegistry.getInstance();
    const c1 = r.counter('test', { a: '1', b: '2' });
    const c2 = r.counter('test', { b: '2', a: '1' });
    expect(c1).toBe(c2);
  });
});
