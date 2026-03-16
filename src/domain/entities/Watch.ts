import { DomainError } from '../errors/DomainError';
import { VerificationStatus } from '../enums/VerificationStatus';

export class Watch {
  readonly id: string;
  readonly ownerId: string;
  readonly marketValue: number;
  readonly verificationStatus: VerificationStatus;
  readonly createdAt: Date;

  constructor(params: {
    id: string;
    ownerId: string;
    marketValue: number;
    verificationStatus: VerificationStatus;
    createdAt: Date;
  }) {
    if (!params.id) {
      throw new DomainError('Watch ID is required', 'INVALID_VALUATION');
    }

    if (!params.ownerId) {
      throw new DomainError('Owner ID is required', 'INVALID_OWNER');
    }

    if (params.marketValue <= 0) {
      throw new DomainError(
        'Market value must be greater than zero',
        'INVALID_VALUATION',
      );
    }

    if (!params.verificationStatus) {
      throw new DomainError(
        'Verification status is required',
        'WATCH_NOT_VERIFIED',
      );
    }

    this.id = params.id;
    this.ownerId = params.ownerId;
    this.marketValue = params.marketValue;
    this.verificationStatus = params.verificationStatus;
    this.createdAt = params.createdAt;
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
