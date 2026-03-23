/**
 * Immutable, append-only audit log entry for operational control actions.
 *
 * Every admin action, freeze, review state change, and override
 * produces an AuditLogEntry. Entries are NEVER mutable and NEVER deleted.
 */
export interface AuditLogEntry {
  readonly id: string;
  readonly actorId: string;
  readonly actionType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly timestamp: Date;
}
