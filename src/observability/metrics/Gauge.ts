/**
 * Point-in-time gauge. Can go up or down.
 * O(1) set/increment. Non-blocking.
 */

import { MetricLabels, MetricSnapshot } from './MetricTypes';

export class Gauge {
  readonly name: string;
  readonly labels: MetricLabels;
  private _value = 0;

  constructor(name: string, labels: MetricLabels = {}) {
    this.name = name;
    this.labels = labels;
  }

  set(value: number): void {
    this._value = value;
  }

  increment(amount: number = 1): void {
    this._value += amount;
  }

  decrement(amount: number = 1): void {
    this._value -= amount;
  }

  get value(): number {
    return this._value;
  }

  snapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: 'gauge',
      labels: this.labels,
      value: this._value,
    };
  }

  reset(): void {
    this._value = 0;
  }
}
