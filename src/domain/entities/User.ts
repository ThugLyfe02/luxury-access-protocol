import { DomainError } from '../errors/DomainError';
import { MarketplaceRole } from '../enums/MarketplaceRole';

export class User {
  readonly id: string;
  readonly role: MarketplaceRole;
  readonly createdAt: Date;
  private _trustScore: number;
  private _disputesCount: number;
  private _chargebacksCount: number;

  constructor(params: {
    id: string;
    role: MarketplaceRole;
    trustScore: number;
    disputesCount: number;
    chargebacksCount: number;
    createdAt: Date;
  }) {
    if (!params.id) {
      throw new DomainError('User ID is required', 'INVALID_NAME');
    }

    if (params.trustScore < 0 || params.trustScore > 100) {
      throw new DomainError(
        'Trust score must be between 0 and 100',
        'INVALID_OWNER',
      );
    }

    if (params.disputesCount < 0) {
      throw new DomainError(
        'Disputes count cannot be negative',
        'INVALID_OWNER',
      );
    }

    if (params.chargebacksCount < 0) {
      throw new DomainError(
        'Chargebacks count cannot be negative',
        'INVALID_OWNER',
      );
    }

    this.id = params.id;
    this.role = params.role;
    this._trustScore = params.trustScore;
    this._disputesCount = params.disputesCount;
    this._chargebacksCount = params.chargebacksCount;
    this.createdAt = params.createdAt;
  }

  get trustScore(): number {
    return this._trustScore;
  }

  get disputesCount(): number {
    return this._disputesCount;
  }

  get chargebacksCount(): number {
    return this._chargebacksCount;
  }

  isHighRisk(): boolean {
    return (
      this._trustScore < 30 ||
      this._chargebacksCount >= 2 ||
      this._disputesCount >= 3
    );
  }

  incrementDisputes(): void {
    this._disputesCount += 1;
  }

  incrementChargebacks(): void {
    this._chargebacksCount += 1;
  }
}
