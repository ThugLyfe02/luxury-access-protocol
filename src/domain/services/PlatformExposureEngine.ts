import { DomainError } from '../errors/DomainError';

/**
 * Snapshot of current platform-wide exposure state.
 * Computed by the caller from active rental and insurance data.
 * The engine does not query repositories — it receives pre-computed values.
 */
export interface ExposureSnapshot {
  /** Sum of watch market values for all active (non-terminal) rentals. */
  readonly totalActiveWatchValue: number;
  /** Sum of net insurance coverage (coverage - deductible) across active rentals. */
  readonly totalInsuranceCoverage: number;
  /** Number of currently active (non-terminal) rentals. */
  readonly activeRentalCount: number;
}

/**
 * Capital / exposure configuration.
 * All values must be positive finite numbers.
 * Passed explicitly — no hidden globals.
 */
export interface ExposureConfig {
  /** Total capital reserve available to absorb losses (in dollars). */
  readonly capitalReserve: number;
  /**
   * Maximum ratio of uncovered exposure to capital reserve.
   * E.g., 3.0 means uncovered exposure can be at most 3x capital reserve.
   */
  readonly maxExposureToCapitalRatio: number;
  /**
   * Maximum uncovered remainder for any single watch (in dollars).
   * Prevents catastrophic single-asset concentration.
   */
  readonly maxSingleWatchUncoveredExposure: number;
  /** Maximum number of concurrent active rentals platform-wide. */
  readonly maxActiveRentals: number;
}

/**
 * Pure domain service enforcing platform-wide capital exposure limits.
 *
 * This is NOT internal escrow or custody logic. It determines whether
 * the platform's aggregate risk surface permits a new rental to proceed.
 * No funds are held, moved, or reserved by this engine.
 */
export class PlatformExposureEngine {
  /**
   * Validate that the exposure config itself is structurally sound.
   * Called before any exposure check to prevent NaN/Infinity/missing config
   * from silently disabling protection.
   */
  static validateConfig(config: ExposureConfig): void {
    if (
      !Number.isFinite(config.capitalReserve) ||
      config.capitalReserve <= 0
    ) {
      throw new DomainError(
        'Capital reserve must be a positive finite number',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }

    if (
      !Number.isFinite(config.maxExposureToCapitalRatio) ||
      config.maxExposureToCapitalRatio <= 0
    ) {
      throw new DomainError(
        'Max exposure-to-capital ratio must be a positive finite number',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }

    if (
      !Number.isFinite(config.maxSingleWatchUncoveredExposure) ||
      config.maxSingleWatchUncoveredExposure <= 0
    ) {
      throw new DomainError(
        'Max single-watch uncovered exposure must be a positive finite number',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }

    if (
      !Number.isInteger(config.maxActiveRentals) ||
      config.maxActiveRentals <= 0
    ) {
      throw new DomainError(
        'Max active rentals must be a positive integer',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }
  }

  /**
   * Validate that the snapshot is structurally sound.
   */
  private static validateSnapshot(snapshot: ExposureSnapshot): void {
    if (
      !Number.isFinite(snapshot.totalActiveWatchValue) ||
      snapshot.totalActiveWatchValue < 0
    ) {
      throw new DomainError(
        'Total active watch value must be a non-negative finite number',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }

    if (
      !Number.isFinite(snapshot.totalInsuranceCoverage) ||
      snapshot.totalInsuranceCoverage < 0
    ) {
      throw new DomainError(
        'Total insurance coverage must be a non-negative finite number',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }

    if (
      !Number.isInteger(snapshot.activeRentalCount) ||
      snapshot.activeRentalCount < 0
    ) {
      throw new DomainError(
        'Active rental count must be a non-negative integer',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }
  }

  /**
   * Compute the platform's current uncovered exposure.
   * Uncovered exposure = total watch value - total insurance coverage,
   * floored at zero (insurance cannot create negative exposure).
   */
  static computeUncoveredExposure(snapshot: ExposureSnapshot): number {
    return Math.max(
      0,
      snapshot.totalActiveWatchValue - snapshot.totalInsuranceCoverage,
    );
  }

  /**
   * Hard-stop check: can the platform absorb a new rental given current
   * aggregate exposure and the proposed rental's risk surface?
   *
   * This must be called BEFORE external payment session creation.
   * A rental that passes local economics but fails aggregate exposure
   * must not proceed to checkout.
   */
  static assertRentalWithinExposureLimits(
    config: ExposureConfig,
    currentSnapshot: ExposureSnapshot,
    proposedRental: {
      watchMarketValue: number;
      insuranceCoverage: number;
    },
  ): void {
    PlatformExposureEngine.validateConfig(config);
    PlatformExposureEngine.validateSnapshot(currentSnapshot);

    // Validate proposed rental inputs
    if (
      !Number.isFinite(proposedRental.watchMarketValue) ||
      proposedRental.watchMarketValue <= 0
    ) {
      throw new DomainError(
        'Proposed watch market value must be a positive finite number',
        'INVALID_VALUATION',
      );
    }

    if (
      !Number.isFinite(proposedRental.insuranceCoverage) ||
      proposedRental.insuranceCoverage < 0
    ) {
      throw new DomainError(
        'Proposed insurance coverage must be a non-negative finite number',
        'PLATFORM_EXPOSURE_VIOLATION',
      );
    }

    // Gate 1: Active rental count limit
    if (currentSnapshot.activeRentalCount >= config.maxActiveRentals) {
      throw new DomainError(
        'Platform has reached the maximum number of active rentals',
        'PLATFORM_EXPOSURE_LIMIT',
      );
    }

    // Gate 2: Single-watch uncovered remainder
    const proposedUncovered = Math.max(
      0,
      proposedRental.watchMarketValue - proposedRental.insuranceCoverage,
    );
    if (proposedUncovered > config.maxSingleWatchUncoveredExposure) {
      throw new DomainError(
        `Single-watch uncovered exposure of $${proposedUncovered.toFixed(2)} exceeds cap of $${config.maxSingleWatchUncoveredExposure.toFixed(2)}`,
        'RISK_EXCEEDS_CAP',
      );
    }

    // Gate 3: Aggregate exposure-to-capital ratio
    const currentUncovered =
      PlatformExposureEngine.computeUncoveredExposure(currentSnapshot);
    const projectedUncovered = currentUncovered + proposedUncovered;
    const maxAllowedExposure =
      config.capitalReserve * config.maxExposureToCapitalRatio;

    if (projectedUncovered > maxAllowedExposure) {
      throw new DomainError(
        `Projected uncovered exposure of $${projectedUncovered.toFixed(2)} exceeds platform cap of $${maxAllowedExposure.toFixed(2)}`,
        'PLATFORM_EXPOSURE_LIMIT',
      );
    }
  }
}
