import { DomainError } from '../errors/DomainError';
import { InsurancePolicyStatus } from '../enums/InsurancePolicyStatus';

const ALL_INSURANCE_STATUSES: ReadonlySet<string> = new Set(
  Object.values(InsurancePolicyStatus),
);

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
  }): InsurancePolicy {
    InsurancePolicy.validate(params);

    if (!ALL_INSURANCE_STATUSES.has(params.status)) {
      throw new DomainError(
        `Unknown insurance policy status from persistence: ${params.status}`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    return new InsurancePolicy({
      ...params,
      status: params.status as InsurancePolicyStatus,
    });
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
