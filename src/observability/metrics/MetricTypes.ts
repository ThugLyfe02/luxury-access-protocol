/**
 * Metric type definitions for the observability system.
 *
 * All metrics are in-memory, pull-based, O(1) update, non-blocking.
 * No external dependencies.
 */

export interface MetricLabels {
  readonly [key: string]: string;
}

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSnapshot {
  readonly name: string;
  readonly type: MetricType;
  readonly labels: MetricLabels;
  readonly value: number;
  readonly extra?: Record<string, unknown>;
}

export interface HistogramSnapshot extends MetricSnapshot {
  readonly type: 'histogram';
  readonly extra: {
    readonly count: number;
    readonly sum: number;
    readonly min: number;
    readonly max: number;
    readonly buckets: ReadonlyArray<{ le: number; count: number }>;
  };
}
