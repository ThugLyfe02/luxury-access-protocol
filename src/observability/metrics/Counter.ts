/**
 * Monotonically increasing counter.
 * O(1) increment. Non-blocking.
 */

import { MetricLabels, MetricSnapshot } from './MetricTypes';

export class Counter {
  readonly name: string;
  readonly labels: MetricLabels;
  private _value = 0;

  constructor(name: string, labels: MetricLabels = {}) {
    this.name = name;
    this.labels = labels;
  }

  increment(amount: number = 1): void {
    if (amount < 0) return; // counters only go up
    this._value += amount;
  }

  get value(): number {
    return this._value;
  }

  snapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: 'counter',
      labels: this.labels,
      value: this._value,
    };
  }

  reset(): void {
    this._value = 0;
  }
}
