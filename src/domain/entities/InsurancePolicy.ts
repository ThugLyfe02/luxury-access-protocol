import { DomainError } from '../errors/DomainError';
import { InsurancePolicyStatus } from '../enums/InsurancePolicyStatus';

const ALL_INSURANCE_STATUSES: ReadonlySet<string> = new Set(
  Object.values(InsurancePolicyStatus),
);

/**
 * Minimum coverage-to-deductible ratio. A policy where the deductible
 * consumes most of the coverage is operationally useless.
 * Enforced: deductible must be < 50% of coverage.
 */
const MAX_DEDUCTIBLE_RATIO = 0.5;

export class InsurancePolicy {
  readonly id: string;
  readonly watchId: string;
  readonly providerId: string;
  readonly coverageAmount: number;
  readonly deductible: number;
  readonly premiumPerRental: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date;
  readonly createdAt: Date;
  private _status: InsurancePolicyStatus;
  private _version: number;

  private constructor(params: {
    id: string;
    watchId: string;
    providerId: string;
    coverageAmount: number;
    deductible: number;
    premiumPerRental: number;
    effectiveFrom: Date;
    effectiveTo: Date;
    status: InsurancePolicyStatus;
    createdAt: Date;
    version: number;
  }) {
    this.id = params.id;
    this.watchId = params.watchId;
    this.providerId = params.providerId;
    this.coverageAmount = params.coverageAmount;
    this.deductible = params.deductible;
    this.premiumPerRental = params.premiumPerRental;
    this.effectiveFrom = params.effectiveFrom;
    this.effectiveTo = params.effectiveTo;
    this._status = params.status;
    this.createdAt = params.createdAt;
    this._version = params.version;
  }

  private static validate(params: {
    id: string;
    watchId: string;
    providerId: string;
    coverageAmount: number;
    deductible: number;
    premiumPerRental: number;
    effectiveFrom: Date;
    effectiveTo: Date;
  }): void {
    if (!params.id) {
      throw new DomainError(
        'Insurance policy ID is required',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (!params.watchId) {
      throw new DomainError(
        'Watch ID is required for insurance policy',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (!params.providerId) {
      throw new DomainError(
        'Provider ID is required for insurance policy',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (
      params.coverageAmount <= 0 ||
      !Number.isFinite(params.coverageAmount)
    ) {
      throw new DomainError(
        'Coverage amount must be a positive finite number',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.deductible < 0 || !Number.isFinite(params.deductible)) {
      throw new DomainError(
        'Deductible must be a non-negative finite number',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.deductible >= params.coverageAmount) {
      throw new DomainError(
        'Deductible must be less than coverage amount',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.deductible > params.coverageAmount * MAX_DEDUCTIBLE_RATIO) {
      throw new DomainError(
        `Deductible exceeds ${MAX_DEDUCTIBLE_RATIO * 100}% of coverage — policy is operationally insufficient`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (
      params.premiumPerRental < 0 ||
      !Number.isFinite(params.premiumPerRental)
    ) {
      throw new DomainError(
        'Premium per rental must be a non-negative finite number',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.effectiveTo <= params.effectiveFrom) {
      throw new DomainError(
        'Effective end date must be after start date',
        'INSURANCE_POLICY_INVALID',
      );
    }
  }

  static create(params: {
    id: string;
    watchId: string;
    providerId: string;
    coverageAmount: number;
    deductible: number;
    premiumPerRental: number;
    effectiveFrom: Date;
    effectiveTo: Date;
    createdAt: Date;
  }): InsurancePolicy {
    InsurancePolicy.validate(params);

    return new InsurancePolicy({
      ...params,
      status: InsurancePolicyStatus.ACTIVE,
      version: 0,
    });
  }

  static restore(params: {
    id: string;
    watchId: string;
    providerId: string;
    coverageAmount: number;
    deductible: number;
    premiumPerRental: number;
    effectiveFrom: Date;
    effectiveTo: Date;
    status: string;
    createdAt: Date;
    version: number;
  }): InsurancePolicy {
    // Skip deductible ratio check on restore — policy was already validated
    // at creation time and persisted data should not be rejected for
    // tightened validation rules.
    if (!params.id) {
      throw new DomainError('Insurance policy ID is required', 'INSURANCE_POLICY_INVALID');
    }
    if (!params.watchId) {
      throw new DomainError('Watch ID is required for insurance policy', 'INSURANCE_POLICY_INVALID');
    }
    if (!params.providerId) {
      throw new DomainError('Provider ID is required for insurance policy', 'INSURANCE_POLICY_INVALID');
    }
    if (params.coverageAmount <= 0 || !Number.isFinite(params.coverageAmount)) {
      throw new DomainError('Coverage amount must be a positive finite number', 'INSURANCE_POLICY_INVALID');
    }
    if (params.deductible < 0 || !Number.isFinite(params.deductible)) {
      throw new DomainError('Deductible must be a non-negative finite number', 'INSURANCE_POLICY_INVALID');
    }
    if (params.deductible >= params.coverageAmount) {
      throw new DomainError('Deductible must be less than coverage amount', 'INSURANCE_POLICY_INVALID');
    }
    if (params.premiumPerRental < 0 || !Number.isFinite(params.premiumPerRental)) {
      throw new DomainError('Premium per rental must be a non-negative finite number', 'INSURANCE_POLICY_INVALID');
    }
    if (params.effectiveTo <= params.effectiveFrom) {
      throw new DomainError('Effective end date must be after start date', 'INSURANCE_POLICY_INVALID');
    }

    if (!ALL_INSURANCE_STATUSES.has(params.status)) {
      throw new DomainError(
        `Unknown insurance policy status from persistence: ${params.status}`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (!Number.isInteger(params.version) || params.version < 0) {
      throw new DomainError(
        'Version must be a non-negative integer',
        'VERSION_CONFLICT',
      );
    }

    return new InsurancePolicy({
      ...params,
      status: params.status as InsurancePolicyStatus,
    });
  }

  // --- Getters ---

  get status(): InsurancePolicyStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  // --- Query methods ---

  isActive(asOf: Date): boolean {
    return (
      this._status === InsurancePolicyStatus.ACTIVE &&
      asOf >= this.effectiveFrom &&
      asOf < this.effectiveTo
    );
  }

  coversValue(watchMarketValue: number): boolean {
    return this.coverageAmount >= watchMarketValue;
  }

  netCoverage(): number {
    return this.coverageAmount - this.deductible;
  }

  /**
   * Remaining effective days from the given date.
   * Returns 0 if already expired or not active.
   */
  remainingDays(asOf: Date): number {
    if (!this.isActive(asOf)) return 0;
    const remainingMs = this.effectiveTo.getTime() - asOf.getTime();
    return Math.max(0, Math.floor(remainingMs / (1000 * 60 * 60 * 24)));
  }

  /**
   * Whether the policy is nearing expiration (within 30 days).
   */
  isNearingExpiration(asOf: Date): boolean {
    return this.isActive(asOf) && this.remainingDays(asOf) <= 30;
  }

  // --- Mutation methods ---

  markExpired(): void {
    if (this._status !== InsurancePolicyStatus.ACTIVE) {
      throw new DomainError(
        'Only active policies can expire',
        'INSURANCE_INACTIVE',
      );
    }
    this._status = InsurancePolicyStatus.EXPIRED;
    this._version += 1;
  }

  markCancelled(): void {
    if (this._status !== InsurancePolicyStatus.ACTIVE) {
      throw new DomainError(
        'Only active policies can be cancelled',
        'INSURANCE_INACTIVE',
      );
    }
    this._status = InsurancePolicyStatus.CANCELLED;
    this._version += 1;
  }

  markClaimed(): void {
    if (this._status !== InsurancePolicyStatus.ACTIVE) {
      throw new DomainError(
        'Only active policies can be claimed',
        'INSURANCE_INACTIVE',
      );
    }
    this._status = InsurancePolicyStatus.CLAIMED;
    this._version += 1;
  }
}
