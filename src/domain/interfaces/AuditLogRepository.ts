import { AuditLogEntry } from '../entities/AuditLogEntry';

export interface AuditLogRepository {
  log(entry: AuditLogEntry): Promise<void>;
  findByEntityId(entityId: string): Promise<ReadonlyArray<AuditLogEntry>>;
  findByActorId(actorId: string): Promise<ReadonlyArray<AuditLogEntry>>;
  entries(): ReadonlyArray<AuditLogEntry>;
}
