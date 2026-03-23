import { DomainError } from '../errors/DomainError';
import { MarketplaceRole } from '../enums/MarketplaceRole';

const ALL_MARKETPLACE_ROLES: ReadonlySet<string> = new Set(
  Object.values(MarketplaceRole),
);

export class User {
  readonly id: string;
  readonly role: MarketplaceRole;
  readonly createdAt: Date;
  private _trustScore: number;
  private _disputesCount: number;
  private _chargebacksCount: number;

  private constructor(params: {
    id: string;
    role: MarketplaceRole;
    trustScore: number;
    disputesCount: number;
    chargebacksCount: number;
    createdAt: Date;
  }) {
    this.id = params.id;
    this.role = params.role;
    this._trustScore = params.trustScore;
    this._disputesCount = params.disputesCount;
    this._chargebacksCount = params.chargebacksCount;
    this.createdAt = params.createdAt;
  }

  private static validate(params: {
    id: string;
    role: string;
    trustScore: number;
    disputesCount: number;
    chargebacksCount: number;
  }): void {
    if (!params.id) {
      throw new DomainError('User ID is required', 'INVALID_OWNER');
    }

    if (!ALL_MARKETPLACE_ROLES.has(params.role)) {
      throw new DomainError(
        `Unknown marketplace role: ${params.role}`,
        'INVALID_OWNER',
      );
    }

    if (
      !Number.isFinite(params.trustScore) ||
      params.trustScore < 0 ||
      params.trustScore > 100
    ) {
      throw new DomainError(
        'Trust score must be a finite number between 0 and 100',
        'INVALID_OWNER',
      );
    }

    if (!Number.isInteger(params.disputesCount) || params.disputesCount < 0) {
      throw new DomainError(
        'Disputes count must be a non-negative integer',
        'INVALID_OWNER',
      );
    }

    if (
      !Number.isInteger(params.chargebacksCount) ||
      params.chargebacksCount < 0
    ) {
      throw new DomainError(
        'Chargebacks count must be a non-negative integer',
        'INVALID_OWNER',
      );
    }
  }

  static create(params: {
    id: string;
    role: MarketplaceRole;
    trustScore: number;
    disputesCount: number;
    chargebacksCount: number;
    createdAt: Date;
  }): User {
    User.validate({
      id: params.id,
      role: params.role,
      trustScore: params.trustScore,
      disputesCount: params.disputesCount,
      chargebacksCount: params.chargebacksCount,
    });

    return new User(params);
  }

  static restore(params: {
    id: string;
    role: string;
    trustScore: number;
    disputesCount: number;
    chargebacksCount: number;
    createdAt: Date;
  }): User {
    User.validate(params);

    return new User({
      ...params,
      role: params.role as MarketplaceRole,
    });
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
