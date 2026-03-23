import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';
import { AuditLog } from '../audit/AuditLog';
import { AuditEntry } from '../audit/AuditEntry';

/**
 * Query filters for audit log inspection.
 * All fields are optional — omitted fields match all entries.
 */
export interface AuditQueryFilter {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: string;
  readonly outcome?: 'success' | 'blocked' | 'error';
  readonly errorCode?: string;
  readonly correlationId?: string;
  readonly externalRef?: string;
  /** Only include entries at or after this timestamp. */
  readonly from?: Date;
  /** Only include entries at or before this timestamp. */
  readonly to?: Date;
}

/**
 * Application service for admin inspection of the structured audit trail.
 *
 * Read-only. No mutations. Admin-only access.
 *
 * This service provides filtered, paginated access to audit entries
 * so ops teams can trace decisions, diagnose blocks, and verify
 * state transitions without direct storage access.
 */
export class AdminAuditQueryService {
  private readonly auditLog: AuditLog;

  constructor(auditLog: AuditLog) {
    this.auditLog = auditLog;
  }

  /**
   * Query audit entries matching the given filter.
   * Results are returned in reverse chronological order (newest first).
   * Limited to `limit` entries starting from `offset`.
   */
  query(
    actor: Actor,
    filter: AuditQueryFilter,
    limit: number = 50,
    offset: number = 0,
  ): AuditEntry[] {
    AuthorizationGuard.requireAdmin(actor);

    const allEntries = this.auditLog.entries();
    let filtered = allEntries.filter((entry) => this.matchesFilter(entry, filter));

    // Sort newest first
    filtered = [...filtered].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get all audit entries for a specific entity.
   * Useful for tracing the full lifecycle of a rental, review case, etc.
   */
  getEntityHistory(
    actor: Actor,
    entityType: string,
    entityId: string,
  ): AuditEntry[] {
    AuthorizationGuard.requireAdmin(actor);

    const allEntries = this.auditLog.entries();
    return [...allEntries]
      .filter((e) => e.entityType === entityType && e.entityId === entityId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Get all audit entries linked by a correlation ID.
   * Useful for tracing a complete multi-step operation (e.g., rental initiation).
   */
  getCorrelatedEntries(
    actor: Actor,
    correlationId: string,
  ): AuditEntry[] {
    AuthorizationGuard.requireAdmin(actor);

    const allEntries = this.auditLog.entries();
    return [...allEntries]
      .filter((e) => e.correlationId === correlationId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Count entries matching the filter. Useful for dashboards.
   */
  count(actor: Actor, filter: AuditQueryFilter): number {
    AuthorizationGuard.requireAdmin(actor);

    const allEntries = this.auditLog.entries();
    return allEntries.filter((entry) => this.matchesFilter(entry, filter)).length;
  }

  private matchesFilter(entry: AuditEntry, filter: AuditQueryFilter): boolean {
    if (filter.entityType && entry.entityType !== filter.entityType) return false;
    if (filter.entityId && entry.entityId !== filter.entityId) return false;
    if (filter.action && entry.action !== filter.action) return false;
    if (filter.outcome && entry.outcome !== filter.outcome) return false;
    if (filter.errorCode && entry.errorCode !== filter.errorCode) return false;
    if (filter.correlationId && entry.correlationId !== filter.correlationId) return false;
    if (filter.externalRef && entry.externalRef !== filter.externalRef) return false;
    if (filter.from && entry.timestamp < filter.from) return false;
    if (filter.to && entry.timestamp > filter.to) return false;
    return true;
  }
}
