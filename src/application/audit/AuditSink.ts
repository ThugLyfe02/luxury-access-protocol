import { AuditEntry } from './AuditEntry';

/**
 * Append-only sink for structured audit entries.
 *
 * The sink is intentionally fire-and-forget from the caller's perspective.
 * Audit recording must not block or fail the primary operation.
 * Implementations should handle their own error recovery.
 */
export interface AuditSink {
  record(entry: AuditEntry): void;
  entries(): ReadonlyArray<AuditEntry>;
}
