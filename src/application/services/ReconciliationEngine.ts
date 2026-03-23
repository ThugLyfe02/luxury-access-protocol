import { ReconciliationRun } from '../../domain/entities/ReconciliationRun';
import { ReconciliationFinding } from '../../domain/entities/ReconciliationFinding';
import { ReconciliationRepository } from '../../domain/interfaces/ReconciliationRepository';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { OutboxRepository } from '../../domain/interfaces/OutboxRepository';
import { AuditLogRepository } from '../../domain/interfaces/AuditLogRepository';
import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { Rental } from '../../domain/entities/Rental';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { DriftDetector } from '../../domain/reconciliation/DriftDetector';
import { InternalSnapshotBuilder } from '../../domain/reconciliation/InternalSnapshot';
import { ProviderSnapshotAdapter } from '../../domain/reconciliation/ProviderSnapshot';
import { DriftTaxonomy } from '../../domain/services/DriftTaxonomy';
import { RepairPolicy } from '../../domain/reconciliation/RepairPolicy';
import { RepairExecutor } from './RepairExecutor';
import {
  isValidTransferId,
  assertTransferPrecedence,
  assertEventCollectionComplete,
} from '../../domain/invariants/TransferTruthInvariants';

export interface ReconcileOneResult {
  readonly rentalId: string;
  readonly findingsCreated: number;
  readonly autoRepaired: number;
  readonly escalated: number;
  readonly errors: string[];
}

/**
 * Reconciliation engine: compares internal state against provider truth
 * and emits deterministic findings.
 *
 * Supports:
 * - Single aggregate reconciliation
 * - Batch reconciliation
 * - Full sweep with run summary
 */
export class ReconciliationEngine {
  private readonly outboxRepo: OutboxRepository | null;

  constructor(
    reconciliationRepo: ReconciliationRepository,
    rentalRepo: RentalRepository,
    providerAdapter: ProviderSnapshotAdapter,
    repairExecutor: RepairExecutor,
    auditLogRepo: AuditLogRepository,
    outboxRepo?: OutboxRepository,
  );
  /** @deprecated Use the 6-arg constructor. This overload preserves backward compatibility. */
  constructor(
    reconciliationRepo: ReconciliationRepository,
    rentalRepo: RentalRepository,
    providerAdapter: ProviderSnapshotAdapter,
    repairExecutor: RepairExecutor,
    auditLogRepo: AuditLogRepository,
  );
  constructor(
    private readonly reconciliationRepo: ReconciliationRepository,
    private readonly rentalRepo: RentalRepository,
    private readonly providerAdapter: ProviderSnapshotAdapter,
    private readonly repairExecutor: RepairExecutor,
    private readonly auditLogRepo: AuditLogRepository,
    outboxRepo?: OutboxRepository,
  ) {
    this.outboxRepo = outboxRepo ?? null;
  }

  /**
   * Reconcile a single rental against provider truth.
   */
  async reconcileOne(rental: Rental, runId: string, triggeredBy: string): Promise<ReconcileOneResult> {
    const result: ReconcileOneResult = {
      rentalId: rental.id,
      findingsCreated: 0,
      autoRepaired: 0,
      escalated: 0,
      errors: [],
    };

    if (!rental.externalPaymentIntentId) {
      return result; // Nothing to reconcile — no provider reference
    }

    try {
      let internal = InternalSnapshotBuilder.fromRental(rental);
      const provider = await this.providerAdapter.fetchPaymentSnapshot(rental.externalPaymentIntentId);

      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      // Transfer truth check: verify transfer state using the best available transfer ID.
      // Primary source: Rental.externalTransferId (set during normal write-back).
      // Fallback source: outbox event result (set when provider succeeded but write-back failed).
      let transferIdForReconciliation = rental.externalTransferId;

      if (!transferIdForReconciliation && this.outboxRepo) {
        const rawRecoveredId = await this.recoverTransferIdFromOutbox(rental.id);

        // INVARIANT 4: Validate recovered transfer ID format before accepting.
        if (rawRecoveredId && !isValidTransferId(rawRecoveredId)) {
          console.warn(
            `[INVARIANT_GUARD] Rental ${rental.id}: recovered transferId "${rawRecoveredId}" ` +
            `does not match expected Stripe format (tr_*). Rejecting as invalid.`,
          );
        } else {
          transferIdForReconciliation = rawRecoveredId;
        }

        // INVARIANT 3: Enforce precedence — persisted always wins, mismatch throws.
        // At this point rental.externalTransferId is null (we're in the !transferIdForReconciliation branch),
        // so assertTransferPrecedence will return 'recovered' or 'none'.
        assertTransferPrecedence(rental.externalTransferId, transferIdForReconciliation);

        // Crash-window backfill: if outbox proves a transfer succeeded at Stripe
        // but the rental's write-back was never completed (externalTransferId is null,
        // escrowStatus is still CAPTURED), attempt to complete the state transition now.
        //
        // This is safe because:
        // - The SUCCEEDED outbox event proves provider success (validated in N.5).
        // - releaseFunds() enforces its own guards (returnConfirmed, !disputeOpen).
        // - Already-released rentals are skipped (idempotent).
        // - No money movement occurs — this is pure internal state completion.
        // - Failure is non-fatal: backfill is caught and logged; drift detection
        //   proceeds with the original state.
        if (transferIdForReconciliation) {
          const backfilled = await this.attemptTransferBackfill(rental, transferIdForReconciliation, triggeredBy);
          if (backfilled) {
            // Rebuild internal snapshot to reflect completed backfill.
            // This ensures subsequent drift detection operates on the
            // now-correct state (FUNDS_RELEASED_TO_OWNER + externalTransferId).
            internal = InternalSnapshotBuilder.fromRental(rental);
          }
        }
      }

      if (transferIdForReconciliation) {
        const transferSnapshot = await this.providerAdapter.fetchTransferSnapshot(transferIdForReconciliation);
        const transferDrifts = DriftDetector.detectTransferDrift(
          // If the rental doesn't have the transfer ID but we recovered it from outbox
          // and backfill failed, inject it into the internal snapshot so drift detection
          // can still run. If backfill succeeded, rental already has the transferId.
          transferIdForReconciliation !== rental.externalTransferId
            ? { ...internal, externalTransferId: transferIdForReconciliation }
            : internal,
          transferSnapshot,
        );
        drifts.push(...transferDrifts);
      }

      for (const drift of drifts) {
        // Dedup: skip if an open finding already exists for this drift
        const existing = await this.reconciliationRepo.findOpenByAggregateAndDrift(
          'Rental', rental.id, drift.driftType,
        );
        if (existing) continue;

        const classification = DriftTaxonomy.classify(drift.driftType);

        const finding = ReconciliationFinding.create({
          id: crypto.randomUUID(),
          runId,
          aggregateType: 'Rental',
          aggregateId: rental.id,
          providerObjectIds: drift.providerObjectIds,
          internalSnapshot: drift.internalSnapshot,
          providerSnapshot: drift.providerSnapshot,
          driftType: drift.driftType,
          severity: classification.severity,
          recommendedAction: classification.recommendedAction,
          createdAt: new Date(),
        });

        await this.reconciliationRepo.createFinding(finding);
        (result as { findingsCreated: number }).findingsCreated++;

        // Attempt auto-repair if policy allows
        if (classification.autoRepairAllowed) {
          const repairResult = await this.repairExecutor.autoRepair(finding, triggeredBy);
          if (repairResult.repaired) {
            (result as { autoRepaired: number }).autoRepaired++;
          }
        }

        // Escalate if required
        if (classification.freezeRequired || classification.reviewRequired) {
          await this.repairExecutor.escalate(finding, triggeredBy);
          (result as { escalated: number }).escalated++;
        }
      }
    } catch (error) {
      (result as { errors: string[] }).errors.push(
        error instanceof Error ? error.message : String(error),
      );
    }

    return result;
  }

  /**
   * Run a full reconciliation sweep over all active rentals.
   * Creates a run record, processes each rental, and stores summary.
   */
  async runFullSweep(triggeredBy: string): Promise<ReconciliationRun> {
    const run = ReconciliationRun.create({
      id: crypto.randomUUID(),
      triggeredBy,
      startedAt: new Date(),
    });
    await this.reconciliationRepo.createRun(run);

    await this.logAudit(triggeredBy, 'reconciliation_run_started', 'ReconciliationRun', run.id);

    try {
      const rentals = await this.rentalRepo.findAll();

      for (const rental of rentals) {
        run.recordChecked();

        try {
          const oneResult = await this.reconcileOne(rental, run.id, triggeredBy);

          for (let i = 0; i < oneResult.findingsCreated; i++) {
            // Determine severity from findings for this rental
            run.recordFinding(
              DriftTaxonomy.classify(
                (await this.reconciliationRepo.findByAggregate('Rental', rental.id))
                  .filter(f => f.runId === run.id)
                  .pop()?.driftType ?? 'ORPHAN_INTERNAL_RECORD' as any,
              ).severity,
            );
          }

          for (let i = 0; i < oneResult.autoRepaired; i++) run.recordRepair();
          for (let i = 0; i < oneResult.escalated; i++) run.recordEscalation();
          if (oneResult.errors.length > 0) run.recordFailedCheck();
        } catch {
          run.recordFailedCheck();
        }
      }

      run.complete(new Date());
      await this.reconciliationRepo.saveRun(run);
      await this.logAudit(triggeredBy, 'reconciliation_run_completed', 'ReconciliationRun', run.id);
    } catch (error) {
      run.fail(error instanceof Error ? error.message : String(error), new Date());
      await this.reconciliationRepo.saveRun(run);
      await this.logAudit(triggeredBy, 'reconciliation_run_failed', 'ReconciliationRun', run.id);
    }

    return run;
  }

  /**
   * Reconcile a single rental by ID (admin on-demand).
   */
  async reconcileById(rentalId: string, triggeredBy: string): Promise<ReconcileOneResult> {
    const rental = await this.rentalRepo.findById(rentalId);
    if (!rental) {
      return { rentalId, findingsCreated: 0, autoRepaired: 0, escalated: 0, errors: ['Rental not found'] };
    }

    const run = ReconciliationRun.create({
      id: crypto.randomUUID(),
      triggeredBy,
      startedAt: new Date(),
    });
    await this.reconciliationRepo.createRun(run);

    const result = await this.reconcileOne(rental, run.id, triggeredBy);

    run.recordChecked();
    run.complete(new Date());
    await this.reconciliationRepo.saveRun(run);

    return result;
  }

  /**
   * Attempt to complete a crash-window transfer write-back.
   *
   * Called when outbox recovery found a valid transferId but the rental
   * has not yet transitioned to FUNDS_RELEASED_TO_OWNER. This completes
   * the same state transition that TransferToOwnerHandler.completeRentalRelease
   * would have done if the original write-back had succeeded.
   *
   * Guards:
   * - Already released → skip (idempotent), return false
   * - returnConfirmed = false → releaseFunds throws → caught, return false
   * - disputeOpen = true → releaseFunds throws → caught, return false
   * - OCC conflict on save → caught, return false (retry on next sweep)
   *
   * No money movement occurs — the Stripe transfer already happened.
   * This is purely internal state completion.
   *
   * @returns true if rental was successfully backfilled and saved
   */
  private async attemptTransferBackfill(rental: Rental, transferId: string, triggeredBy: string): Promise<boolean> {
    if (rental.escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER) {
      return false; // Already released — nothing to backfill
    }

    try {
      rental.releaseFunds(transferId);
      await this.rentalRepo.save(rental);
      await this.logAudit(triggeredBy, 'reconciliation_transfer_backfill', 'Rental', rental.id);
      return true;
    } catch (error) {
      // Backfill failed (dispute opened, return not confirmed, OCC conflict, etc.)
      // Non-fatal: drift detection will proceed with the original state.
      // The next reconciliation sweep will retry.
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isOccConflict = errorMsg.includes('VERSION_CONFLICT');
      console.warn(
        `[SAFETY_WARNING] Backfill failed for rental ${rental.id}: ${errorMsg}` +
        (isOccConflict ? ' (OCC conflict — will retry on next sweep)' : ''),
      );
      return false;
    }
  }

  /**
   * Recover transfer ID from outbox event result.
   *
   * When the TransferToOwnerHandler succeeds at Stripe but write-back to Rental
   * fails (OCC conflict, dispute lock, crash), the real transferId is still
   * captured in the outbox event's result field via markSucceeded(now, { transferId }).
   *
   * This method finds the SUCCEEDED transfer outbox event for a rental and
   * extracts the transferId, enabling reconciliation to verify transfer truth
   * even when Rental.externalTransferId is missing.
   *
   * Selection policy:
   * - Only SUCCEEDED events with topic payment.transfer_to_owner are considered.
   * - The result.transferId must be a non-empty string to be accepted.
   * - Events are returned by findByAggregate in created_at ASC order; the first
   *   matching event is used. Under normal operation the dedup key
   *   (transfer:{rentalId}) prevents duplicates, so at most one match exists.
   *
   * Retention assumption:
   * This fallback depends on SUCCEEDED outbox events remaining queryable.
   * If outbox events are purged or archived, recovery silently returns null
   * (fail-safe: no false findings, but transfer verification is skipped).
   * Outbox retention must span at least the reconciliation sweep interval
   * plus any reasonable crash-recovery window.
   */
  private async recoverTransferIdFromOutbox(rentalId: string): Promise<string | null> {
    const events = await this.outboxRepo!.findByAggregate('Rental', rentalId);

    // INVARIANT 2: Assert event collection was not truncated by a LIMIT.
    assertEventCollectionComplete(events, `recoverTransferIdFromOutbox(${rentalId})`);

    for (const event of events) {
      if (
        event.topic === 'payment.transfer_to_owner' &&
        event.status === 'SUCCEEDED' &&
        event.result &&
        typeof event.result.transferId === 'string' &&
        event.result.transferId.length > 0
      ) {
        return event.result.transferId;
      }
    }

    return null;
  }

  private async logAudit(actorId: string, actionType: string, entityType: string, entityId: string): Promise<void> {
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      actorId,
      actionType,
      entityType,
      entityId,
      metadata: {},
      timestamp: new Date(),
    };
    await this.auditLogRepo.log(entry);
  }
}
