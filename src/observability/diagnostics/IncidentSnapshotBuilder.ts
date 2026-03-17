/**
 * Incident snapshot builder.
 *
 * Given a rentalId, reconstructs the full lifecycle:
 * - Audit log entries
 * - Outbox events
 * - Reconciliation findings
 *
 * Enables end-to-end incident forensics without log searching.
 */

import { OutboxRepository } from '../../domain/interfaces/OutboxRepository';
import { ReconciliationRepository } from '../../domain/interfaces/ReconciliationRepository';
import { AuditLog } from '../../application/audit/AuditLog';

export interface IncidentSnapshot {
  readonly rentalId: string;
  readonly generatedAt: string;
  readonly auditEntries: ReadonlyArray<{
    timestamp: string;
    action: string;
    outcome: string;
    actor: string;
    beforeState?: string | null;
    afterState?: string | null;
    errorCode?: string | null;
    externalRef?: string | null;
  }>;
  readonly outboxEvents: ReadonlyArray<{
    id: string;
    topic: string;
    status: string;
    attemptCount: number;
    createdAt: string;
    lastError?: string | null;
  }>;
  readonly reconciliationFindings: ReadonlyArray<{
    id: string;
    driftType: string;
    severity: string;
    status: string;
    createdAt: string;
    resolvedAt?: string | null;
  }>;
}

export class IncidentSnapshotBuilder {
  private readonly outboxRepo: OutboxRepository;
  private readonly reconciliationRepo: ReconciliationRepository;
  private readonly auditLog: AuditLog;

  constructor(
    outboxRepo: OutboxRepository,
    reconciliationRepo: ReconciliationRepository,
    auditLog: AuditLog,
  ) {
    this.outboxRepo = outboxRepo;
    this.reconciliationRepo = reconciliationRepo;
    this.auditLog = auditLog;
  }

  async buildForRental(rentalId: string): Promise<IncidentSnapshot> {
    // Gather all data in parallel
    const [outboxEvents, reconFindings] = await Promise.all([
      this.outboxRepo.findByAggregate('Rental', rentalId),
      this.reconciliationRepo.findByAggregate('Rental', rentalId),
    ]);

    // Filter audit entries for this rental
    const allAuditEntries = this.auditLog.entries();
    const rentalAuditEntries = allAuditEntries.filter(
      e => e.entityId === rentalId || e.correlationId === rentalId,
    );

    return {
      rentalId,
      generatedAt: new Date().toISOString(),
      auditEntries: rentalAuditEntries.map(e => ({
        timestamp: e.timestamp.toISOString(),
        action: e.action,
        outcome: e.outcome,
        actor: e.actor.kind === 'system' ? `system:${e.actor.source}` : e.actor.userId,
        beforeState: e.beforeState,
        afterState: e.afterState,
        errorCode: e.errorCode,
        externalRef: e.externalRef,
      })),
      outboxEvents: outboxEvents.map(e => ({
        id: e.id,
        topic: e.topic,
        status: e.status,
        attemptCount: e.attemptCount,
        createdAt: e.createdAt.toISOString(),
        lastError: e.lastError,
      })),
      reconciliationFindings: reconFindings.map(f => ({
        id: f.id,
        driftType: f.driftType,
        severity: f.severity,
        status: f.status,
        createdAt: f.createdAt.toISOString(),
        resolvedAt: f.resolvedAt?.toISOString() ?? null,
      })),
    };
  }
}
