/**
 * Singleton metrics registry.
 *
 * All metrics are registered here. getSnapshot() returns all metric values
 * for pull-based scraping. No blocking I/O, no mutex, no external deps.
 */

import { Counter } from './Counter';
import { Gauge } from './Gauge';
import { Histogram } from './Histogram';
import { MetricSnapshot, MetricLabels } from './MetricTypes';

export class MetricsRegistry {
  private static _instance: MetricsRegistry | null = null;

  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  private constructor() {}

  static getInstance(): MetricsRegistry {
    if (!MetricsRegistry._instance) {
      MetricsRegistry._instance = new MetricsRegistry();
    }
    return MetricsRegistry._instance;
  }

  /** Reset singleton for testing */
  static resetForTesting(): void {
    MetricsRegistry._instance = null;
  }

  private metricKey(name: string, labels: MetricLabels): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  counter(name: string, labels: MetricLabels = {}): Counter {
    const key = this.metricKey(name, labels);
    let c = this.counters.get(key);
    if (!c) {
      c = new Counter(name, labels);
      this.counters.set(key, c);
    }
    return c;
  }

  gauge(name: string, labels: MetricLabels = {}): Gauge {
    const key = this.metricKey(name, labels);
    let g = this.gauges.get(key);
    if (!g) {
      g = new Gauge(name, labels);
      this.gauges.set(key, g);
    }
    return g;
  }

  histogram(name: string, labels: MetricLabels = {}, buckets?: number[]): Histogram {
    const key = this.metricKey(name, labels);
    let h = this.histograms.get(key);
    if (!h) {
      h = new Histogram(name, labels, buckets);
      this.histograms.set(key, h);
    }
    return h;
  }

  getSnapshot(): MetricSnapshot[] {
    const snapshots: MetricSnapshot[] = [];
    for (const c of this.counters.values()) snapshots.push(c.snapshot());
    for (const g of this.gauges.values()) snapshots.push(g.snapshot());
    for (const h of this.histograms.values()) snapshots.push(h.snapshot());
    return snapshots;
  }

  reset(): void {
    for (const c of this.counters.values()) c.reset();
    for (const g of this.gauges.values()) g.reset();
    for (const h of this.histograms.values()) h.reset();
  }
}
