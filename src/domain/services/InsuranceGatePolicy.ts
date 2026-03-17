import { DomainError } from '../errors/DomainError';
import { InsurancePolicy } from '../entities/InsurancePolicy';
import { InsurancePolicyStatus } from '../enums/InsurancePolicyStatus';
import { InsuranceClaim } from '../entities/InsuranceClaim';
import { Watch } from '../entities/Watch';

/**
 * Domain service that enforces insurance-related preconditions.
 *
 * Aggregates policy validity, coverage sufficiency, and claim state
 * into deterministic hard-stop gates for rental and release flows.
 */
export class InsuranceGatePolicy {
  /**
   * Assert that a watch's insurance is valid for a new rental.
   * For high-value watches: policy must be active, cover the value,
   * and have no open claims on the watch.
   *
   * Non-high-value watches: no insurance requirement, but if there
   * are open claims, they still block.
   */
  static assertInsuranceClearForRental(
    watch: Watch,
    policy: InsurancePolicy | null,
    openClaims: InsuranceClaim[],
    asOf: Date,
  ): void {
    // Open claims on the watch block ALL new rentals regardless of value
    const watchOpenClaims = openClaims.filter((c) => c.watchId === watch.id && c.isOpen());
    if (watchOpenClaims.length > 0) {
      throw new DomainError(
        `Watch ${watch.id} has ${watchOpenClaims.length} open insurance claim(s) — new rentals blocked`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    // High-value watches require active insurance with sufficient coverage
    if (watch.isHighValue()) {
      if (!policy) {
        throw new DomainError(
          'Active insurance is required for high-value watches',
          'INSURANCE_INACTIVE',
        );
      }

      if (!policy.isActive(asOf)) {
        throw new DomainError(
          'Insurance policy is not active',
          'INSURANCE_INACTIVE',
        );
      }

      if (!policy.coversValue(watch.marketValue)) {
        throw new DomainError(
          `Insurance coverage ($${policy.coverageAmount}) is insufficient for watch market value ($${watch.marketValue})`,
          'INSURANCE_POLICY_INVALID',
        );
      }
    }
  }

  /**
   * Assert that insurance state permits fund release for a rental.
   * Open claims on the associated watch or rental block release.
   */
  static assertInsuranceClearForRelease(
    rentalId: string,
    watchId: string,
    openClaims: InsuranceClaim[],
  ): void {
    // Claims directly on this rental block release
    const rentalClaims = openClaims.filter(
      (c) => c.rentalId === rentalId && c.isOpen(),
    );
    if (rentalClaims.length > 0) {
      throw new DomainError(
        `Rental ${rentalId} has ${rentalClaims.length} open insurance claim(s) — fund release blocked`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    // Claims on the watch (from any rental) also block release
    const watchClaims = openClaims.filter(
      (c) => c.watchId === watchId && c.isOpen(),
    );
    if (watchClaims.length > 0) {
      throw new DomainError(
        `Watch ${watchId} has ${watchClaims.length} open insurance claim(s) — fund release blocked`,
        'INSURANCE_POLICY_INVALID',
      );
    }
  }

  /**
   * Validate that a claim can be filed against a policy.
   * Policy must be active (or claimed), claim amount must not exceed coverage.
   */
  static assertCanFileClaim(
    policy: InsurancePolicy,
    claimAmount: number,
    asOf: Date,
  ): void {
    // Policy must be active or already in CLAIMED state (multiple claims possible)
    if (!policy.isActive(asOf) && policy.status !== InsurancePolicyStatus.CLAIMED) {
      throw new DomainError(
        'Cannot file claim against inactive insurance policy',
        'INSURANCE_INACTIVE',
      );
    }

    if (claimAmount > policy.coverageAmount) {
      throw new DomainError(
        `Claim amount ($${claimAmount}) exceeds policy coverage ($${policy.coverageAmount})`,
        'INSURANCE_POLICY_INVALID',
      );
    }

    if (claimAmount <= policy.deductible) {
      throw new DomainError(
        `Claim amount ($${claimAmount}) does not exceed deductible ($${policy.deductible})`,
        'INSURANCE_POLICY_INVALID',
      );
    }
  }
}
