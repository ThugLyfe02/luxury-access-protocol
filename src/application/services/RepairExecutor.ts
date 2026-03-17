import { DomainError } from '../../domain/errors/DomainError';
import { DriftType } from '../../domain/enums/DriftType';
import { ReconciliationFinding } from '../../domain/entities/ReconciliationFinding';
import { ReconciliationRepository } from '../../domain/interfaces/ReconciliationRepository';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { FreezeRepository } from '../../domain/interfaces/FreezeRepository';
import { ManualReviewRepository } from '../../domain/interfaces/ManualReviewRepository';
import { AuditLogRepository } from '../../domain/interfaces/AuditLogRepository';
import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { SystemFreeze } from '../../domain/entities/SystemFreeze';
import { ManualReviewCase } from '../../domain/entities/ManualReviewCase';
import { ReviewSeverity } from '../../domain/enums/ReviewSeverity';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { RepairPolicy } from '../../domain/reconciliation/RepairPolicy';
import { DriftTaxonomy } from '../../domain/services/DriftTaxonomy';

export interface RepairResult {
  readonly repaired: boolean;
  readonly action: string;
  readonly findingId: string;
  readonly froze: boolean;
  readonly reviewCreated: boolean;
}

/**
 * Safe, explicit repair executor for reconciliation findings.
 *
 * Every repair action is:
 * - Idempotent
 * - Audited
 * - Explicit (named action)
 * - Conservative (only auto-repairs what the policy allows)
 */
export class RepairExecutor {
  constructor(
    private readonly reconciliationRepo: ReconciliationRepository,
    private readonly rentalRepo: RentalRepository,
    private readonly freezeRepo: FreezeRepository,
    private readonly reviewRepo: ManualReviewRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  /**
   * Attempt auto-repair of a finding if policy allows.
   * Returns the result of the repair attempt.
   */
  async autoRepair(finding: ReconciliationFinding, actorId: string): Promise<RepairResult> {
    const decision = RepairPolicy.canAutoRepair(finding);
    const now = new Date();

    if (!decision.allowed) {
      return { repaired: false, action: decision.reason, findingId: finding.id, froze: false, reviewCreated: false };
    }

    let repaired = false;
    const action = decision.action;

    switch (finding.driftType) {
      case DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED:
        repaired = await this.syncCaptured(finding);
        break;
      case DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN:
        repaired = await this.syncDispute(finding);
        break;
      default:
        return { repaired: false, action: `No auto-repair handler for ${finding.driftType}`, findingId: finding.id, froze: false, reviewCreated: false };
    }

    if (repaired) {
      finding.markRepaired(actorId, action, now);
      await this.reconciliationRepo.saveFinding(finding);
      await this.logAudit(actorId, 'reconciliation_auto_repair', finding);
    }

    return { repaired, action, findingId: finding.id, froze: false, reviewCreated: false };
  }

  /**
   * Escalate a finding: freeze entity and/or open manual review as required.
   */
  async escalate(finding: ReconciliationFinding, actorId: string): Promise<RepairResult> {
    const classification = DriftTaxonomy.classify(finding.driftType);
    const now = new Date();
    let froze = false;
    let reviewCreated = false;

    if (classification.freezeRequired) {
      await this.freezeEntity(finding, actorId, now);
      froze = true;
    }

    if (classification.reviewRequired) {
      await this.openReviewCase(finding, actorId, now);
      reviewCreated = true;
    }

    finding.escalate(actorId, now);
    await this.reconciliationRepo.saveFinding(finding);
    await this.logAudit(actorId, 'reconciliation_escalation', finding);

    return {
      repaired: false,
      action: `Escalated: freeze=${froze}, review=${reviewCreated}`,
      findingId: finding.id,
      froze,
      reviewCreated,
    };
  }

  /**
   * Manual repair by admin: mark finding as repaired with explicit action.
   */
  async manualRepair(finding: ReconciliationFinding, actorId: string, repairAction: string): Promise<RepairResult> {
    if (!repairAction) throw new DomainError('Repair action is required', 'INVALID_STATE_TRANSITION');
    const now = new Date();
    finding.markRepaired(actorId, repairAction, now);
    await this.reconciliationRepo.saveFinding(finding);
    await this.logAudit(actorId, 'reconciliation_manual_repair', finding);
    return { repaired: true, action: repairAction, findingId: finding.id, froze: false, reviewCreated: false };
  }

  /**
   * Suppress a finding (deterministically benign).
   */
  async suppress(finding: ReconciliationFinding, actorId: string, reason: string): Promise<void> {
    finding.suppress(actorId, reason, new Date());
    await this.reconciliationRepo.saveFinding(finding);
    await this.logAudit(actorId, 'reconciliation_suppress', finding);
  }

  // --- Private repair handlers ---

  private async syncCaptured(finding: ReconciliationFinding): Promise<boolean> {
    const rental = await this.rentalRepo.findById(finding.aggregateId);
    if (!rental) return false;
    if (rental.escrowStatus === EscrowStatus.EXTERNAL_PAYMENT_CAPTURED) return true; // Already synced
    if (rental.escrowStatus !== EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED) return false; // Can't sync from this state

    rental.markPaymentCaptured();
    await this.rentalRepo.save(rental);
    return true;
  }

  private async syncDispute(finding: ReconciliationFinding): Promise<boolean> {
    const rental = await this.rentalRepo.findById(finding.aggregateId);
    if (!rental) return false;
    if (rental.disputeOpen) return true; // Already synced

    // Only sync dispute from states that allow it
    if (
      rental.escrowStatus !== EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED &&
      rental.escrowStatus !== EscrowStatus.EXTERNAL_PAYMENT_CAPTURED
    ) {
      return false;
    }

    rental.markDisputed();
    await this.rentalRepo.save(rental);
    return true;
  }

  private async freezeEntity(finding: ReconciliationFinding, actorId: string, now: Date): Promise<void> {
    const freeze = SystemFreeze.create({
      id: crypto.randomUUID(),
      entityType: finding.aggregateType === 'Rental' ? 'RENTAL' : 'USER',
      entityId: finding.aggregateId,
      reason: `Reconciliation finding ${finding.id}: ${finding.driftType}`,
      frozenBy: actorId,
      createdAt: now,
    });
    await this.freezeRepo.create(freeze);
  }

  private async openReviewCase(finding: ReconciliationFinding, actorId: string, now: Date): Promise<void> {
    // Check if review already exists to avoid duplicates
    const existing = await this.reviewRepo.findOpenByEntity(finding.aggregateType, finding.aggregateId);
    if (existing.length > 0) return;

    const severity = finding.severity === 'CRITICAL' ? ReviewSeverity.CRITICAL : ReviewSeverity.HIGH;
    const reviewCase = ManualReviewCase.create({
      id: crypto.randomUUID(),
      rentalId: finding.aggregateType === 'Rental' ? finding.aggregateId : `recon:${finding.aggregateId}`,
      severity,
      reason: `Reconciliation drift: ${finding.driftType} — ${DriftTaxonomy.classify(finding.driftType).description}`,
      createdAt: now,
      freezeTargets: [{ entityType: finding.aggregateType as 'Rental' | 'User' | 'Watch', entityId: finding.aggregateId }],
    });
    await this.reviewRepo.create(reviewCase);
  }

  private async logAudit(actorId: string, actionType: string, finding: ReconciliationFinding): Promise<void> {
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      actorId,
      actionType,
      entityType: 'ReconciliationFinding',
      entityId: finding.id,
      metadata: {
        driftType: finding.driftType,
        severity: finding.severity,
        aggregateType: finding.aggregateType,
        aggregateId: finding.aggregateId,
        status: finding.status,
        repairAction: finding.repairAction,
      },
      timestamp: new Date(),
    };
    await this.auditLogRepo.log(entry);
  }
}
