import { DriftType } from '../enums/DriftType';
import { ReconciliationSeverity } from '../enums/ReconciliationSeverity';

/**
 * Recommended action for a drift finding.
 *
 * SYNC_INTERNAL: Update internal state to match provider truth.
 * OPEN_REVIEW: Create a manual review case for human assessment.
 * FREEZE_ENTITY: Freeze the related entity for safety.
 * ENQUEUE_RECHECK: Schedule a follow-up reconciliation check.
 * NO_ACTION: Finding is informational, no corrective action needed.
 */
export type RecommendedAction =
  | 'SYNC_INTERNAL'
  | 'OPEN_REVIEW'
  | 'FREEZE_ENTITY'
  | 'ENQUEUE_RECHECK'
  | 'NO_ACTION';

export interface DriftClassification {
  readonly severity: ReconciliationSeverity;
  readonly recommendedAction: RecommendedAction;
  readonly autoRepairAllowed: boolean;
  readonly freezeRequired: boolean;
  readonly reviewRequired: boolean;
  readonly description: string;
}

/**
 * Drift taxonomy: deterministic mapping from drift type to classification.
 *
 * Auto-repair is only allowed when:
 * - Action is monotonic (forward-only state sync)
 * - External truth is authoritative
 * - No money release ambiguity
 * - Idempotency is guaranteed
 *
 * Human review required when:
 * - Money release ambiguity exists
 * - Dispute state affects liability
 * - Conflicting terminal states
 * - Provider object missing with committed internal state
 */
const DRIFT_CLASSIFICATIONS: ReadonlyMap<DriftType, DriftClassification> = new Map([
  [DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING, {
    severity: ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    autoRepairAllowed: false,
    freezeRequired: true,
    reviewRequired: true,
    description: 'Internal state shows payment authorized but provider has no record. Possible data loss or provider failure.',
  }],

  [DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED, {
    severity: ReconciliationSeverity.HIGH,
    recommendedAction: 'SYNC_INTERNAL',
    autoRepairAllowed: true,
    freezeRequired: false,
    reviewRequired: false,
    description: 'Provider confirms capture but internal state not updated. Safe to sync forward — monotonic, externally confirmed.',
  }],

  [DriftType.INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED, {
    severity: ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    autoRepairAllowed: false,
    freezeRequired: true,
    reviewRequired: true,
    description: 'Internal state shows funds released but provider has not transferred. Money movement discrepancy — requires manual investigation.',
  }],

  [DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN, {
    severity: ReconciliationSeverity.HIGH,
    recommendedAction: 'SYNC_INTERNAL',
    autoRepairAllowed: true,
    freezeRequired: false,
    reviewRequired: false,
    description: 'Provider shows active dispute but internal state is clean. Safe to sync — dispute acknowledgment is monotonic and conservative.',
  }],

  [DriftType.INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED, {
    severity: ReconciliationSeverity.MEDIUM,
    recommendedAction: 'ENQUEUE_RECHECK',
    autoRepairAllowed: false,
    freezeRequired: false,
    reviewRequired: true,
    description: 'Internal shows dispute open but provider says resolved. May be timing issue — recheck before clearing dispute flag.',
  }],

  [DriftType.REFUND_STATE_MISMATCH, {
    severity: ReconciliationSeverity.HIGH,
    recommendedAction: 'OPEN_REVIEW',
    autoRepairAllowed: false,
    freezeRequired: false,
    reviewRequired: true,
    description: 'Refund status disagrees between internal and provider. Money already moved — requires human verification.',
  }],

  [DriftType.CONNECTED_ACCOUNT_STATE_MISMATCH, {
    severity: ReconciliationSeverity.LOW,
    recommendedAction: 'ENQUEUE_RECHECK',
    autoRepairAllowed: false,
    freezeRequired: false,
    reviewRequired: false,
    description: 'Connected account status differs. Typically transient — onboarding in progress.',
  }],

  [DriftType.DUPLICATE_PROVIDER_REFERENCE, {
    severity: ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    autoRepairAllowed: false,
    freezeRequired: true,
    reviewRequired: true,
    description: 'Same provider reference linked to multiple internal records. Data integrity issue.',
  }],

  [DriftType.ORPHAN_PROVIDER_OBJECT, {
    severity: ReconciliationSeverity.MEDIUM,
    recommendedAction: 'OPEN_REVIEW',
    autoRepairAllowed: false,
    freezeRequired: false,
    reviewRequired: true,
    description: 'Provider has payment object with no matching internal record. Possible missed webhook.',
  }],

  [DriftType.ORPHAN_INTERNAL_RECORD, {
    severity: ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    autoRepairAllowed: false,
    freezeRequired: true,
    reviewRequired: true,
    description: 'Internal record has committed payment state with no provider match. Possible provider data loss.',
  }],

  [DriftType.TRANSFER_REVERSED_BUT_INTERNAL_RELEASED, {
    severity: ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    autoRepairAllowed: false,
    freezeRequired: true,
    reviewRequired: true,
    description: 'Provider transfer reversed but internal state shows funds released. Money movement reversal requires manual investigation.',
  }],

  [DriftType.TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED, {
    severity: ReconciliationSeverity.CRITICAL,
    recommendedAction: 'FREEZE_ENTITY',
    autoRepairAllowed: false,
    freezeRequired: true,
    reviewRequired: true,
    description: 'Internal shows funds released with transfer ID but provider has no record. Transfer may have failed silently.',
  }],
]);

export class DriftTaxonomy {
  static classify(driftType: DriftType): DriftClassification {
    const classification = DRIFT_CLASSIFICATIONS.get(driftType);
    if (!classification) {
      throw new Error(`Unknown drift type: ${driftType}`);
    }
    return classification;
  }

  static allClassifications(): ReadonlyMap<DriftType, DriftClassification> {
    return DRIFT_CLASSIFICATIONS;
  }
}
