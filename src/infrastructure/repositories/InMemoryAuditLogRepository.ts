import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { AuditLogRepository } from '../../domain/interfaces/AuditLogRepository';

/**
 * In-memory, append-only audit log repository.
 * Entries are NEVER mutable and NEVER deleted.
 */
export class InMemoryAuditLogRepository implements AuditLogRepository {
  private readonly _entries: AuditLogEntry[] = [];

  async log(entry: AuditLogEntry): Promise<void> {
    // Append only — no updates, no deletes
    this._entries.push(Object.freeze(entry));
  }

  async findByEntityId(entityId: string): Promise<ReadonlyArray<AuditLogEntry>> {
    return this._entries.filter((e) => e.entityId === entityId);
  }

  async findByActorId(actorId: string): Promise<ReadonlyArray<AuditLogEntry>> {
    return this._entries.filter((e) => e.actorId === actorId);
  }

  entries(): ReadonlyArray<AuditLogEntry> {
    return this._entries;
  }
}
