import { DriftType } from '../enums/DriftType';
import { DriftTaxonomy, DriftClassification } from '../services/DriftTaxonomy';
import { ReconciliationFinding } from '../entities/ReconciliationFinding';

export type RepairDecision =
  | { allowed: true; action: string }
  | { allowed: false; reason: string };

/**
 * Conservative repair policy.
 *
 * Auto-repair is only permitted when:
 * 1. The drift taxonomy explicitly allows it
 * 2. The action is monotonic (forward-only state sync)
 * 3. External truth is authoritative for this drift type
 * 4. No money release ambiguity
 * 5. Idempotency is guaranteed
 *
 * All other cases require explicit human action.
 */
export class RepairPolicy {
  /**
   * Determine if a finding can be auto-repaired.
   */
  static canAutoRepair(finding: ReconciliationFinding): RepairDecision {
    const classification = DriftTaxonomy.classify(finding.driftType);

    if (!classification.autoRepairAllowed) {
      return {
        allowed: false,
        reason: `Drift type ${finding.driftType} requires manual review: ${classification.description}`,
      };
    }

    if (finding.isResolved()) {
      return { allowed: false, reason: 'Finding is already resolved' };
    }

    return {
      allowed: true,
      action: RepairPolicy.describeRepairAction(finding.driftType),
    };
  }

  /**
   * Determine if a finding requires freeze escalation.
   */
  static requiresFreeze(driftType: DriftType): boolean {
    return DriftTaxonomy.classify(driftType).freezeRequired;
  }

  /**
   * Determine if a finding requires manual review escalation.
   */
  static requiresReview(driftType: DriftType): boolean {
    return DriftTaxonomy.classify(driftType).reviewRequired;
  }

  /**
   * Describe the concrete repair action for an auto-repairable drift.
   */
  static describeRepairAction(driftType: DriftType): string {
    switch (driftType) {
      case DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED:
        return 'Sync internal escrow status to EXTERNAL_PAYMENT_CAPTURED based on provider confirmation';
      case DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN:
        return 'Sync internal dispute status to DISPUTED based on provider dispute notification';
      default:
        return `No auto-repair defined for ${driftType}`;
    }
  }
}
