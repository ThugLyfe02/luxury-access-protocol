import { DomainError } from '../errors/DomainError';
import { InsurancePolicyStatus } from '../enums/InsurancePolicyStatus';

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

  constructor(params: {
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
  }) {
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

    if (params.coverageAmount <= 0) {
      throw new DomainError(
        'Coverage amount must be positive',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.deductible < 0) {
      throw new DomainError(
        'Deductible cannot be negative',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.deductible >= params.coverageAmount) {
      throw new DomainError(
        'Deductible must be less than coverage amount',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.premiumPerRental < 0) {
      throw new DomainError(
        'Premium per rental cannot be negative',
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (params.effectiveTo <= params.effectiveFrom) {
      throw new DomainError(
        'Effective end date must be after start date',
        'INSURANCE_POLICY_INVALID',
      );
    }

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
  }

  get status(): InsurancePolicyStatus {
    return this._status;
  }

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

  markExpired(): void {
    if (this._status !== InsurancePolicyStatus.ACTIVE) {
      throw new DomainError(
        'Only active policies can expire',
        'INSURANCE_INACTIVE',
      );
    }
    this._status = InsurancePolicyStatus.EXPIRED;
  }

  markCancelled(): void {
    if (this._status !== InsurancePolicyStatus.ACTIVE) {
      throw new DomainError(
        'Only active policies can be cancelled',
        'INSURANCE_INACTIVE',
      );
    }
    this._status = InsurancePolicyStatus.CANCELLED;
  }

  markClaimed(): void {
    if (this._status !== InsurancePolicyStatus.ACTIVE) {
      throw new DomainError(
        'Only active policies can be claimed',
        'INSURANCE_INACTIVE',
      );
    }
    this._status = InsurancePolicyStatus.CLAIMED;
  }
}
