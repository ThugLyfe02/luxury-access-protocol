import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { WatchRepository } from '../../domain/interfaces/WatchRepository';
import { InsuranceRepository } from '../../domain/interfaces/InsuranceRepository';
import { ExposureSnapshot } from '../../domain/services/PlatformExposureEngine';

/**
 * Computes the platform-wide exposure snapshot from repository-backed truth.
 *
 * This is the single source of truth for exposure state used by both:
 * - Live rental initiation (enforcement path)
 * - Admin exposure reporting (inspection path)
 *
 * The snapshot is computed on-demand from active (non-terminal) rentals.
 * Each active rental contributes its watch's market value to exposure,
 * offset by any active insurance coverage on the watch.
 */
export class ExposureSnapshotService {
  private readonly rentalRepo: RentalRepository;
  private readonly watchRepo: WatchRepository;
  private readonly insuranceRepo: InsuranceRepository;

  constructor(deps: {
    rentalRepo: RentalRepository;
    watchRepo: WatchRepository;
    insuranceRepo: InsuranceRepository;
  }) {
    this.rentalRepo = deps.rentalRepo;
    this.watchRepo = deps.watchRepo;
    this.insuranceRepo = deps.insuranceRepo;
  }

  /**
   * Compute real-time exposure snapshot from active rentals.
   *
   * Active = not in a terminal escrow status (not RELEASED or REFUNDED).
   * For each active rental, we look up the watch value and any active
   * insurance to compute coverage.
   */
  async computeSnapshot(): Promise<ExposureSnapshot> {
    const activeRentals = await this.rentalRepo.findAllActive();

    let totalActiveWatchValue = 0;
    let totalInsuranceCoverage = 0;

    for (const rental of activeRentals) {
      const watch = await this.watchRepo.findById(rental.watchId);
      if (watch) {
        totalActiveWatchValue += watch.marketValue;
        const policy = await this.insuranceRepo.findActiveByWatchId(rental.watchId);
        if (policy) {
          totalInsuranceCoverage += policy.netCoverage();
        }
      }
    }

    return {
      totalActiveWatchValue,
      totalInsuranceCoverage,
      activeRentalCount: activeRentals.length,
    };
  }
}
