import { DomainError } from '../errors/DomainError';
import { MarketplaceRole } from '../enums/MarketplaceRole';
import { VerificationStatus } from '../enums/VerificationStatus';
import { User } from '../entities/User';
import { Watch } from '../entities/Watch';

const HIGH_VALUE_THRESHOLD = 5000;

const ACCEPTABLE_HIGH_VALUE_VERIFICATION: ReadonlySet<VerificationStatus> =
  new Set([
    VerificationStatus.VERIFIED_BY_PARTNER,
    VerificationStatus.VERIFIED_IN_VAULT,
  ]);

const ROLE_RENTAL_CEILINGS: ReadonlyMap<MarketplaceRole, number> = new Map([
  [MarketplaceRole.RENTER, 10_000],
  [MarketplaceRole.OWNER, 25_000],
  [MarketplaceRole.ADMIN, Number.POSITIVE_INFINITY],
]);

export class RiskPolicy {
  static ensureCanInitiateRental(
    user: User,
    watch: Watch,
    rentalValue: number,
  ): void {
    if (user.id === watch.ownerId) {
      throw new DomainError(
        'Invalid rental parties',
        'INVALID_RENTAL_PARTIES',
      );
    }

    if (rentalValue <= 0) {
      throw new DomainError(
        'Rental value must be greater than zero',
        'INVALID_RENTAL_PARTIES',
      );
    }

    if (user.isHighRisk()) {
      throw new DomainError(
        'High-risk users cannot initiate rentals',
        'HIGH_RISK_TRANSACTION',
      );
    }

    if (
      watch.marketValue > HIGH_VALUE_THRESHOLD &&
      !ACCEPTABLE_HIGH_VALUE_VERIFICATION.has(watch.verificationStatus)
    ) {
      throw new DomainError(
        'Watches above $5,000 require at least partner verification',
        'WATCH_NOT_VERIFIED',
      );
    }

    const ceiling = RiskPolicy.getRoleRentalCeiling(user.role);
    if (rentalValue > ceiling) {
      throw new DomainError(
        `Rental value exceeds role ceiling of ${ceiling}`,
        'TIER_ACCESS_DENIED',
      );
    }
  }

  static ensureWatchIsVerified(watch: Watch, rentalValue: number): void {
    if (
      rentalValue > HIGH_VALUE_THRESHOLD &&
      !ACCEPTABLE_HIGH_VALUE_VERIFICATION.has(watch.verificationStatus)
    ) {
      throw new DomainError(
        'Watch must be verified for high-value rentals',
        'WATCH_NOT_VERIFIED',
      );
    }
  }

  static getRoleRentalCeiling(role: MarketplaceRole): number {
    return ROLE_RENTAL_CEILINGS.get(role) ?? 0;
  }
}
