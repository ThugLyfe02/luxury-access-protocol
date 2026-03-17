import { ReconciliationRun } from '../../domain/entities/ReconciliationRun';
import { ReconciliationFinding } from '../../domain/entities/ReconciliationFinding';
import { ReconciliationRepository } from '../../domain/interfaces/ReconciliationRepository';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { AuditLogRepository } from '../../domain/interfaces/AuditLogRepository';
import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { Rental } from '../../domain/entities/Rental';
import { DriftDetector } from '../../domain/reconciliation/DriftDetector';
import { InternalSnapshotBuilder } from '../../domain/reconciliation/InternalSnapshot';
import { ProviderSnapshotAdapter } from '../../domain/reconciliation/ProviderSnapshot';
import { DriftTaxonomy } from '../../domain/services/DriftTaxonomy';
import { RepairPolicy } from '../../domain/reconciliation/RepairPolicy';
import { RepairExecutor } from './RepairExecutor';

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
  constructor(
    private readonly reconciliationRepo: ReconciliationRepository,
    private readonly rentalRepo: RentalRepository,
    private readonly providerAdapter: ProviderSnapshotAdapter,
    private readonly repairExecutor: RepairExecutor,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

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
      const internal = InternalSnapshotBuilder.fromRental(rental);
      const provider = await this.providerAdapter.fetchPaymentSnapshot(rental.externalPaymentIntentId);

      const drifts = DriftDetector.detectPaymentDrift(internal, provider);

      // Transfer truth check: if funds released and transfer ID exists, verify transfer state
      if (rental.externalTransferId) {
        const transferSnapshot = await this.providerAdapter.fetchTransferSnapshot(rental.externalTransferId);
        const transferDrifts = DriftDetector.detectTransferDrift(internal, transferSnapshot);
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
