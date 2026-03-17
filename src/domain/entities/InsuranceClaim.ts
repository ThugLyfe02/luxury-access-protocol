import { DomainError } from '../errors/DomainError';
import { InsuranceClaimStatus } from '../enums/InsuranceClaimStatus';

const ALL_CLAIM_STATUSES: ReadonlySet<string> = new Set(
  Object.values(InsuranceClaimStatus),
);

/**
 * Valid status transitions for the claim FSM.
 * FILED → UNDER_REVIEW → APPROVED → PAID_OUT
 *                       → DENIED
 */
const VALID_CLAIM_TRANSITIONS: ReadonlyMap<InsuranceClaimStatus, ReadonlySet<InsuranceClaimStatus>> =
  new Map([
    [InsuranceClaimStatus.FILED, new Set([InsuranceClaimStatus.UNDER_REVIEW])],
    [InsuranceClaimStatus.UNDER_REVIEW, new Set([
      InsuranceClaimStatus.APPROVED,
      InsuranceClaimStatus.DENIED,
    ])],
    [InsuranceClaimStatus.APPROVED, new Set([InsuranceClaimStatus.PAID_OUT])],
    [InsuranceClaimStatus.DENIED, new Set<InsuranceClaimStatus>()],
    [InsuranceClaimStatus.PAID_OUT, new Set<InsuranceClaimStatus>()],
  ]);

/**
 * Insurance claim filed against a policy for a specific rental.
 *
 * A claim represents a request for payout due to damage, loss,
 * or other covered event. The claim lifecycle is:
 * FILED → UNDER_REVIEW → APPROVED → PAID_OUT
 *                       → DENIED (terminal)
 *
 * Open claims (FILED, UNDER_REVIEW, APPROVED) block:
 * - new rentals on the same watch
 * - fund release for the associated rental
 */
export class InsuranceClaim {
  readonly id: string;
  readonly policyId: string;
  readonly rentalId: string;
  readonly watchId: string;
  readonly claimAmount: number;
  readonly reason: string;
  readonly filedAt: Date;
  private _status: InsuranceClaimStatus;
  private _reviewedBy: string | null;
  private _reviewedAt: Date | null;
  private _paidOutAt: Date | null;
  private _payoutAmount: number | null;
  private _denialReason: string | null;
  private _version: number;

  private constructor(params: {
    id: string;
    policyId: string;
    rentalId: string;
    watchId: string;
    claimAmount: number;
    reason: string;
    filedAt: Date;
    status: InsuranceClaimStatus;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    paidOutAt: Date | null;
    payoutAmount: number | null;
    denialReason: string | null;
    version: number;
  }) {
    this.id = params.id;
    this.policyId = params.policyId;
    this.rentalId = params.rentalId;
    this.watchId = params.watchId;
    this.claimAmount = params.claimAmount;
    this.reason = params.reason;
    this.filedAt = params.filedAt;
    this._status = params.status;
    this._reviewedBy = params.reviewedBy;
    this._reviewedAt = params.reviewedAt;
    this._paidOutAt = params.paidOutAt;
    this._payoutAmount = params.payoutAmount;
    this._denialReason = params.denialReason;
    this._version = params.version;
  }

  static create(params: {
    id: string;
    policyId: string;
    rentalId: string;
    watchId: string;
    claimAmount: number;
    reason: string;
    filedAt: Date;
  }): InsuranceClaim {
    if (!params.id) {
      throw new DomainError('Claim ID is required', 'INSURANCE_POLICY_INVALID');
    }
    if (!params.policyId) {
      throw new DomainError('Policy ID is required for claim', 'INSURANCE_POLICY_INVALID');
    }
    if (!params.rentalId) {
      throw new DomainError('Rental ID is required for claim', 'INSURANCE_POLICY_INVALID');
    }
    if (!params.watchId) {
      throw new DomainError('Watch ID is required for claim', 'INSURANCE_POLICY_INVALID');
    }
    if (params.claimAmount <= 0 || !Number.isFinite(params.claimAmount)) {
      throw new DomainError('Claim amount must be a positive finite number', 'INSURANCE_POLICY_INVALID');
    }
    if (!params.reason) {
      throw new DomainError('Claim reason is required', 'INSURANCE_POLICY_INVALID');
    }

    return new InsuranceClaim({
      ...params,
      status: InsuranceClaimStatus.FILED,
      reviewedBy: null,
      reviewedAt: null,
      paidOutAt: null,
      payoutAmount: null,
      denialReason: null,
      version: 0,
    });
  }

  static restore(params: {
    id: string;
    policyId: string;
    rentalId: string;
    watchId: string;
    claimAmount: number;
    reason: string;
    filedAt: Date;
    status: string;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    paidOutAt: Date | null;
    payoutAmount: number | null;
    denialReason: string | null;
    version: number;
  }): InsuranceClaim {
    if (!ALL_CLAIM_STATUSES.has(params.status)) {
      throw new DomainError(
        `Unknown insurance claim status from persistence: ${params.status}`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (!Number.isInteger(params.version) || params.version < 0) {
      throw new DomainError(
        'Version must be a non-negative integer',
        'VERSION_CONFLICT',
      );
    }

    return new InsuranceClaim({
      ...params,
      status: params.status as InsuranceClaimStatus,
    });
  }

  // --- Getters ---

  get status(): InsuranceClaimStatus { return this._status; }
  get reviewedBy(): string | null { return this._reviewedBy; }
  get reviewedAt(): Date | null { return this._reviewedAt; }
  get paidOutAt(): Date | null { return this._paidOutAt; }
  get payoutAmount(): number | null { return this._payoutAmount; }
  get denialReason(): string | null { return this._denialReason; }
  get version(): number { return this._version; }

  // --- Query methods ---

  /**
   * Whether this claim is still open (not in a terminal state).
   * Open claims block new rentals and fund releases.
   */
  isOpen(): boolean {
    return (
      this._status === InsuranceClaimStatus.FILED ||
      this._status === InsuranceClaimStatus.UNDER_REVIEW ||
      this._status === InsuranceClaimStatus.APPROVED
    );
  }

  isTerminal(): boolean {
    return (
      this._status === InsuranceClaimStatus.DENIED ||
      this._status === InsuranceClaimStatus.PAID_OUT
    );
  }

  // --- Mutation methods (FSM transitions) ---

  /**
   * Begin review of the claim. FILED → UNDER_REVIEW.
   */
  beginReview(reviewerId: string): void {
    if (!reviewerId) {
      throw new DomainError('Reviewer ID is required', 'INSURANCE_POLICY_INVALID');
    }
    this.transitionTo(InsuranceClaimStatus.UNDER_REVIEW);
    this._reviewedBy = reviewerId;
  }

  /**
   * Approve the claim. UNDER_REVIEW → APPROVED.
   * Sets the approved payout amount (may differ from claim amount
   * due to deductible, coverage limits, etc.).
   */
  approve(reviewedAt: Date, payoutAmount: number): void {
    if (payoutAmount <= 0 || !Number.isFinite(payoutAmount)) {
      throw new DomainError(
        'Payout amount must be a positive finite number',
        'INSURANCE_POLICY_INVALID',
      );
    }
    if (payoutAmount > this.claimAmount) {
      throw new DomainError(
        'Payout amount cannot exceed claim amount',
        'INSURANCE_POLICY_INVALID',
      );
    }
    this.transitionTo(InsuranceClaimStatus.APPROVED);
    this._reviewedAt = reviewedAt;
    this._payoutAmount = payoutAmount;
  }

  /**
   * Deny the claim. UNDER_REVIEW → DENIED (terminal).
   */
  deny(reviewedAt: Date, denialReason: string): void {
    if (!denialReason) {
      throw new DomainError('Denial reason is required', 'INSURANCE_POLICY_INVALID');
    }
    this.transitionTo(InsuranceClaimStatus.DENIED);
    this._reviewedAt = reviewedAt;
    this._denialReason = denialReason;
  }

  /**
   * Record payout completion. APPROVED → PAID_OUT (terminal).
   */
  markPaidOut(paidOutAt: Date): void {
    this.transitionTo(InsuranceClaimStatus.PAID_OUT);
    this._paidOutAt = paidOutAt;
  }

  // --- Private helpers ---

  private transitionTo(nextStatus: InsuranceClaimStatus): void {
    const allowed = VALID_CLAIM_TRANSITIONS.get(this._status);
    if (!allowed || !allowed.has(nextStatus)) {
      throw new DomainError(
        `Invalid claim transition from ${this._status} to ${nextStatus}`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = nextStatus;
    this._version += 1;
  }
}
