import { AuditEntry } from '../../application/audit/AuditEntry';
import { AuditSink } from '../../application/audit/AuditSink';

/**
 * In-memory append-only audit sink.
 *
 * Suitable for the current reconstruction stage. In production this
 * would be backed by a durable store (append-only table, event stream,
 * or structured log pipeline).
 */
export class InMemoryAuditSink implements AuditSink {
  private readonly log: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.log.push(entry);
  }

  entries(): ReadonlyArray<AuditEntry> {
    return this.log;
  }
}
