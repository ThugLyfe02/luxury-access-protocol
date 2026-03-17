/**
 * Histogram for latency distributions.
 * O(1) observe. Non-blocking. Fixed bucket boundaries.
 */

import { MetricLabels, HistogramSnapshot } from './MetricTypes';

const DEFAULT_BUCKETS = [5, 10, 50, 100, 250, 500, 1000, 5000];

export class Histogram {
  readonly name: string;
  readonly labels: MetricLabels;
  private readonly bucketBounds: number[];
  private readonly bucketCounts: number[];
  private _count = 0;
  private _sum = 0;
  private _min = Infinity;
  private _max = -Infinity;

  constructor(name: string, labels: MetricLabels = {}, buckets: number[] = DEFAULT_BUCKETS) {
    this.name = name;
    this.labels = labels;
    this.bucketBounds = [...buckets].sort((a, b) => a - b);
    this.bucketCounts = new Array(this.bucketBounds.length).fill(0);
  }

  observe(value: number): void {
    this._count++;
    this._sum += value;
    if (value < this._min) this._min = value;
    if (value > this._max) this._max = value;

    for (let i = 0; i < this.bucketBounds.length; i++) {
      if (value <= this.bucketBounds[i]) {
        this.bucketCounts[i]++;
      }
    }
  }

  get count(): number { return this._count; }
  get sum(): number { return this._sum; }
  get min(): number { return this._count === 0 ? 0 : this._min; }
  get max(): number { return this._count === 0 ? 0 : this._max; }

  get mean(): number {
    return this._count === 0 ? 0 : this._sum / this._count;
  }

  snapshot(): HistogramSnapshot {
    return {
      name: this.name,
      type: 'histogram',
      labels: this.labels,
      value: this.mean,
      extra: {
        count: this._count,
        sum: this._sum,
        min: this.min,
        max: this.max,
        buckets: this.bucketBounds.map((le, i) => ({
          le,
          count: this.bucketCounts[i],
        })),
      },
    };
  }

  reset(): void {
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this.bucketCounts.fill(0);
  }
}
