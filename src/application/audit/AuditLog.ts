import { Actor } from '../auth/Actor';
import { AuditEntry } from './AuditEntry';
import { AuditSink } from './AuditSink';
import { DomainError } from '../../domain/errors/DomainError';

/**
 * Convenience builder for recording structured audit entries.
 *
 * Usage:
 *   auditLog.record({
 *     actor,
 *     entityType: 'Rental',
 *     entityId: rental.id,
 *     action: 'initiate_rental',
 *     outcome: 'success',
 *     afterState: rental.escrowStatus,
 *   });
 *
 * The AuditLog is a thin adapter over AuditSink. It generates IDs
 * and timestamps, and provides a helper for recording blocked operations
 * from caught DomainErrors.
 */
export class AuditLog {
  private readonly sink: AuditSink;

  constructor(sink: AuditSink) {
    this.sink = sink;
  }

  record(params: {
    actor: Actor;
    entityType: string;
    entityId: string;
    action: string;
    outcome: 'success' | 'blocked' | 'error';
    beforeState?: string | null;
    afterState?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    correlationId?: string | null;
    externalRef?: string | null;
  }): void {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      actor: params.actor,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      outcome: params.outcome,
      beforeState: params.beforeState ?? null,
      afterState: params.afterState ?? null,
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      correlationId: params.correlationId ?? null,
      externalRef: params.externalRef ?? null,
    };

    this.sink.record(entry);
  }

  /**
   * Record a blocked operation from a caught DomainError.
   * Extracts code and message automatically.
   */
  recordBlocked(params: {
    actor: Actor;
    entityType: string;
    entityId: string;
    action: string;
    error: DomainError;
    correlationId?: string | null;
    externalRef?: string | null;
  }): void {
    this.record({
      actor: params.actor,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      outcome: 'blocked',
      errorCode: params.error.code,
      errorMessage: params.error.message,
      correlationId: params.correlationId ?? null,
      externalRef: params.externalRef ?? null,
    });
  }

  /**
   * Access the underlying sink's entries for inspection.
   */
  entries(): ReadonlyArray<AuditEntry> {
    return this.sink.entries();
  }
}
