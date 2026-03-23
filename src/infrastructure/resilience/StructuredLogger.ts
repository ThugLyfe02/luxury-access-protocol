/**
 * Structured logger for incident analysis.
 *
 * Provides consistent context across all log entries:
 * requestId, actorId, aggregateId, provider object IDs,
 * outbox event ID, reconciliation IDs, worker name, failure classification.
 */

export interface LogContext {
  readonly requestId?: string;
  readonly actorId?: string;
  readonly aggregateId?: string;
  readonly aggregateType?: string;
  readonly providerObjectId?: string;
  readonly outboxEventId?: string;
  readonly reconciliationRunId?: string;
  readonly reconciliationFindingId?: string;
  readonly workerName?: string;
  readonly failureCategory?: string;
  readonly operation?: string;
  readonly [key: string]: unknown;
}

export interface StructuredLogEntry {
  readonly ts: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly context: LogContext;
}

export interface LogSink {
  write(entry: StructuredLogEntry): void;
}

/** Console-based sink that writes JSON lines */
export class ConsoleLogSink implements LogSink {
  write(entry: StructuredLogEntry): void {
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

/** In-memory sink for testing */
export class InMemoryLogSink implements LogSink {
  readonly entries: StructuredLogEntry[] = [];

  write(entry: StructuredLogEntry): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export class StructuredLogger {
  private readonly sink: LogSink;
  private readonly baseContext: LogContext;

  constructor(sink: LogSink, baseContext: LogContext = {}) {
    this.sink = sink;
    this.baseContext = baseContext;
  }

  /** Create a child logger with additional context */
  child(context: LogContext): StructuredLogger {
    return new StructuredLogger(this.sink, { ...this.baseContext, ...context });
  }

  info(message: string, context: LogContext = {}): void {
    this.log('info', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.log('warn', message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.log('error', message, context);
  }

  private log(level: 'info' | 'warn' | 'error', message: string, context: LogContext): void {
    this.sink.write({
      ts: new Date().toISOString(),
      level,
      message,
      context: { ...this.baseContext, ...context },
    });
  }
}
