/**
 * Enhanced structured logger with observability integration.
 *
 * JSON-only output. Automatically attaches:
 * - timestamp, level, message
 * - requestId, correlationId from RequestContext
 * - component name
 * - errorCode for DomainErrors
 *
 * Fail-open: logging failures NEVER break core flow.
 */

import { getRequestContext } from '../tracing/RequestContext';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ObservabilityLogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly component?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly actorId?: string;
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}

export interface ObservabilityLogSink {
  write(entry: ObservabilityLogEntry): void;
}

export class ConsoleObservabilityLogSink implements ObservabilityLogSink {
  write(entry: ObservabilityLogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === 'error') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (entry.level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }
}

export class InMemoryObservabilityLogSink implements ObservabilityLogSink {
  readonly entries: ObservabilityLogEntry[] = [];
  write(entry: ObservabilityLogEntry): void {
    this.entries.push(entry);
  }
  clear(): void { this.entries.length = 0; }
}

export class ObservabilityLogger {
  private readonly sink: ObservabilityLogSink;
  private readonly component?: string;
  private readonly baseContext: Record<string, unknown>;

  constructor(sink: ObservabilityLogSink, component?: string, baseContext: Record<string, unknown> = {}) {
    this.sink = sink;
    this.component = component;
    this.baseContext = baseContext;
  }

  child(component: string, context: Record<string, unknown> = {}): ObservabilityLogger {
    return new ObservabilityLogger(this.sink, component, { ...this.baseContext, ...context });
  }

  debug(message: string, extra: Record<string, unknown> = {}): void {
    this.log('debug', message, extra);
  }

  info(message: string, extra: Record<string, unknown> = {}): void {
    this.log('info', message, extra);
  }

  warn(message: string, extra: Record<string, unknown> = {}): void {
    this.log('warn', message, extra);
  }

  error(message: string, extra: Record<string, unknown> = {}): void {
    this.log('error', message, extra);
  }

  private log(level: LogLevel, message: string, extra: Record<string, unknown>): void {
    try {
      const ctx = getRequestContext();
      const entry: ObservabilityLogEntry = {
        ts: new Date().toISOString(),
        level,
        message,
        ...(this.component ? { component: this.component } : {}),
        ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
        ...(ctx?.actorId ? { actorId: ctx.actorId } : {}),
        ...this.baseContext,
        ...extra,
      };
      this.sink.write(entry);
    } catch {
      // Fail-open: logging failures NEVER break core flow
    }
  }
}
