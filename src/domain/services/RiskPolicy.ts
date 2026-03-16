import { DomainError } from '../errors/DomainError';
import { MarketplaceRole } from '../enums/MarketplaceRole';
import { VerificationStatus } from '../enums/VerificationStatus';
import { User } from '../entities/User';
import { Watch } from '../entities/Watch';
import { KycProfile } from '../entities/KycProfile';
import { InsurancePolicy } from '../entities/InsurancePolicy';

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

  static ensureKycVerified(kyc: KycProfile | null, asOf: Date): void {
    if (!kyc) {
      throw new DomainError(
        'KYC verification is required before renting',
        'KYC_REQUIRED',
      );
    }

    if (!kyc.isVerified(asOf)) {
      throw new DomainError(
        'KYC verification is not current or has risk flags',
        'KYC_REQUIRED',
      );
    }
  }

  static ensureInsuranceActive(
    insurance: InsurancePolicy | null,
    watch: Watch,
    asOf: Date,
  ): void {
    if (!watch.isHighValue()) {
      return;
    }

    if (!insurance) {
      throw new DomainError(
        'Active insurance is required for high-value watches',
        'INSURANCE_INACTIVE',
      );
    }

    if (!insurance.isActive(asOf)) {
      throw new DomainError(
        'Insurance policy is not active',
        'INSURANCE_INACTIVE',
      );
    }

    if (!insurance.coversValue(watch.marketValue)) {
      throw new DomainError(
        'Insurance coverage is insufficient for watch market value',
        'INSURANCE_POLICY_INVALID',
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
