import {
  ExposureConfig,
  ExposureSnapshot,
  PlatformExposureEngine,
} from '../../domain/services/PlatformExposureEngine';
import { ExposureSnapshotService } from './ExposureSnapshotService';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';

/**
 * Structured report of current platform exposure state.
 */
export interface ExposureReport {
  readonly snapshot: ExposureSnapshot;
  readonly config: ExposureConfig;
  readonly uncoveredExposure: number;
  readonly maxAllowedExposure: number;
  readonly exposureUtilizationPct: number;
  readonly rentalCountUtilizationPct: number;
  readonly headroomDollars: number;
  readonly headroomRentals: number;
}

/**
 * Application service for admin inspection of platform-wide exposure.
 *
 * Computes a real-time exposure snapshot from current active rentals
 * and provides a structured report comparing it against config limits.
 *
 * Read-only. No mutations. Admin-only access.
 *
 * Note: In production, the exposure snapshot would be materialized
 * by a background process. This implementation computes it on-demand
 * from in-memory repositories, which is acceptable for the current
 * reconstruction stage.
 */
export class AdminExposureQueryService {
  private readonly exposureSnapshotService: ExposureSnapshotService;
  private readonly exposureConfig: ExposureConfig;

  constructor(deps: {
    exposureSnapshotService: ExposureSnapshotService;
    exposureConfig: ExposureConfig;
  }) {
    this.exposureSnapshotService = deps.exposureSnapshotService;
    this.exposureConfig = deps.exposureConfig;
  }

  /**
   * Generate a full exposure report for the platform.
   *
   * This computes the current exposure snapshot from active rentals,
   * then compares it against the configured limits to produce
   * utilization percentages and headroom values.
   */
  async generateReport(actor: Actor): Promise<ExposureReport> {
    AuthorizationGuard.requireAdmin(actor);

    const snapshot = await this.exposureSnapshotService.computeSnapshot();
    const config = this.exposureConfig;

    PlatformExposureEngine.validateConfig(config);

    const uncoveredExposure =
      PlatformExposureEngine.computeUncoveredExposure(snapshot);
    const maxAllowedExposure =
      config.capitalReserve * config.maxExposureToCapitalRatio;

    const exposureUtilizationPct =
      maxAllowedExposure > 0
        ? (uncoveredExposure / maxAllowedExposure) * 100
        : 0;

    const rentalCountUtilizationPct =
      config.maxActiveRentals > 0
        ? (snapshot.activeRentalCount / config.maxActiveRentals) * 100
        : 0;

    const headroomDollars = Math.max(0, maxAllowedExposure - uncoveredExposure);
    const headroomRentals = Math.max(
      0,
      config.maxActiveRentals - snapshot.activeRentalCount,
    );

    return {
      snapshot,
      config,
      uncoveredExposure,
      maxAllowedExposure,
      exposureUtilizationPct,
      rentalCountUtilizationPct,
      headroomDollars,
      headroomRentals,
    };
  }

}
