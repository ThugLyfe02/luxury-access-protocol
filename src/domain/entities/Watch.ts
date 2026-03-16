import { DomainError } from '../errors/DomainError';
import { VerificationStatus } from '../enums/VerificationStatus';

const ALL_VERIFICATION_STATUSES: ReadonlySet<string> = new Set(
  Object.values(VerificationStatus),
);

export class Watch {
  readonly id: string;
  readonly ownerId: string;
  readonly marketValue: number;
  readonly verificationStatus: VerificationStatus;
  readonly createdAt: Date;

  private constructor(params: {
    id: string;
    ownerId: string;
    marketValue: number;
    verificationStatus: VerificationStatus;
    createdAt: Date;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.marketValue = params.marketValue;
    this.verificationStatus = params.verificationStatus;
    this.createdAt = params.createdAt;
  }

  private static validate(params: {
    id: string;
    ownerId: string;
    marketValue: number;
    verificationStatus: string;
  }): void {
    if (!params.id) {
      throw new DomainError('Watch ID is required', 'INVALID_VALUATION');
    }

    if (!params.ownerId) {
      throw new DomainError('Owner ID is required', 'INVALID_OWNER');
    }

    if (params.marketValue <= 0 || !Number.isFinite(params.marketValue)) {
      throw new DomainError(
        'Market value must be a positive finite number',
        'INVALID_VALUATION',
      );
    }

    if (!ALL_VERIFICATION_STATUSES.has(params.verificationStatus)) {
      throw new DomainError(
        `Unknown verification status: ${params.verificationStatus}`,
        'WATCH_NOT_VERIFIED',
      );
    }
  }

  static create(params: {
    id: string;
    ownerId: string;
    marketValue: number;
    verificationStatus: VerificationStatus;
    createdAt: Date;
  }): Watch {
    Watch.validate({
      id: params.id,
      ownerId: params.ownerId,
      marketValue: params.marketValue,
      verificationStatus: params.verificationStatus,
    });

    return new Watch(params);
  }

  static restore(params: {
    id: string;
    ownerId: string;
    marketValue: number;
    verificationStatus: string;
    createdAt: Date;
  }): Watch {
    Watch.validate(params);

    return new Watch({
      ...params,
      verificationStatus: params.verificationStatus as VerificationStatus,
    });
  }

  isHighValue(): boolean {
    return this.marketValue >= 5000;
  }

  requiresPartnerVerification(): boolean {
    return (
      this.isHighValue() &&
      this.verificationStatus === VerificationStatus.UNVERIFIED
    );
  }
}
