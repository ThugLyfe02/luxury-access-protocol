import { Request, Response } from 'express';
import { InitiateRentalService } from '../application/services/InitiateRentalService';
import { UserActor } from '../application/auth/Actor';
import { MarketplaceRole } from '../domain/enums/MarketplaceRole';
import { UserRepository } from '../domain/interfaces/UserRepository';
import { WatchRepository } from '../domain/interfaces/WatchRepository';
import { RentalRepository } from '../domain/interfaces/RentalRepository';
import { KycRepository } from '../domain/interfaces/KycRepository';
import { InsuranceRepository } from '../domain/interfaces/InsuranceRepository';
import { ClaimRepository } from '../domain/interfaces/ClaimRepository';
import { ReviewRepository } from '../domain/interfaces/ReviewRepository';
import { TierEngine } from '../domain/services/TierEngine';
import {
  ExposureSnapshot,
  ExposureConfig,
} from '../domain/services/PlatformExposureEngine';
import { EscrowStatus } from '../domain/enums/EscrowStatus';
import { validateInitiateRentalBody } from './validation';
import { sendError } from './errorMapper';

/**
 * HTTP controller for rental operations.
 *
 * This is a thin transport adapter. All business logic lives in
 * InitiateRentalService and the domain layer. The controller's job:
 * 1. Validate HTTP input shape
 * 2. Load entities from repositories
 * 3. Build the Actor context
 * 4. Delegate to the application service
 * 5. Map the result (or error) to an HTTP response
 */
export class RentalController {
  private readonly initiateRentalService: InitiateRentalService;
  private readonly userRepo: UserRepository;
  private readonly watchRepo: WatchRepository;
  private readonly rentalRepo: RentalRepository;
  private readonly kycRepo: KycRepository;
  private readonly insuranceRepo: InsuranceRepository;
  private readonly claimRepo: ClaimRepository;
  private readonly reviewRepo: ReviewRepository;
  private readonly exposureConfig: ExposureConfig;

  constructor(deps: {
    initiateRentalService: InitiateRentalService;
    userRepo: UserRepository;
    watchRepo: WatchRepository;
    rentalRepo: RentalRepository;
    kycRepo: KycRepository;
    insuranceRepo: InsuranceRepository;
    claimRepo: ClaimRepository;
    reviewRepo: ReviewRepository;
    exposureConfig: ExposureConfig;
  }) {
    this.initiateRentalService = deps.initiateRentalService;
    this.userRepo = deps.userRepo;
    this.watchRepo = deps.watchRepo;
    this.rentalRepo = deps.rentalRepo;
    this.kycRepo = deps.kycRepo;
    this.insuranceRepo = deps.insuranceRepo;
    this.claimRepo = deps.claimRepo;
    this.reviewRepo = deps.reviewRepo;
    this.exposureConfig = deps.exposureConfig;
  }

  /**
   * POST /rentals
   *
   * Initiates a new rental. Requires an authenticated renter.
   *
   * Request body: { renterId, watchId, rentalPrice, city, zipCode }
   * Actor context: derived from renterId (placeholder — real auth middleware
   * would extract this from a token, not from the request body).
   */
  async initiateRental(req: Request, res: Response): Promise<void> {
    try {
      // 1. Validate input shape
      const validated = validateInitiateRentalBody(req.body);
      if (!validated.valid) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: validated.errors } });
        return;
      }

      const { renterId, watchId, rentalPrice, city, zipCode } = validated.value;

      // 2. Load entities
      const renter = await this.userRepo.findById(renterId);
      if (!renter) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Renter not found' } });
        return;
      }

      const watch = await this.watchRepo.findById(watchId);
      if (!watch) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Watch not found' } });
        return;
      }

      // 3. Load supporting data
      const renterKyc = await this.kycRepo.findByUserId(renterId);
      const watchInsurance = await this.insuranceRepo.findActiveByWatchId(watchId);

      // 4. Compute renter tier
      const renterRentals = await this.rentalRepo.findByRenterId(renterId);
      const completedRentals = renterRentals.filter(
        (r) => r.escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER,
      ).length;

      const now = new Date();
      const accountAgeDays = Math.floor(
        (now.getTime() - renter.createdAt.getTime()) / (1000 * 60 * 60 * 24),
      );

      const renterTier = TierEngine.computeTier({
        completedRentals,
        accountAgeDays,
        chargebacksCount: renter.chargebacksCount,
      });

      // 5. Compute recent rental timestamps (last 24h for velocity check)
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const recentRentalTimestamps = renterRentals
        .filter((r) => r.createdAt >= oneDayAgo)
        .map((r) => r.createdAt);

      // 6. Compute exposure snapshot from active rentals
      const allWatchRentals = await this.computeExposureSnapshot();

      // 7. Build actor context
      // NOTE: In production, actor would come from authenticated token middleware,
      // not from the request body. This is a structural placeholder.
      const actor: UserActor = {
        kind: 'user',
        userId: renterId,
        role: renter.role as MarketplaceRole,
      };

      // 7b. Load freeze cases for renter and watch
      const renterFreezeCases = await this.reviewRepo.findUnresolvedByFreezeTarget('User', renterId);
      const watchFreezeCases = await this.reviewRepo.findUnresolvedByFreezeTarget('Watch', watchId);

      // 7c. Load open insurance claims for the watch
      const watchOpenClaims = await this.claimRepo.findOpenByWatchId(watchId);

      // 8. Delegate to application service
      const result = await this.initiateRentalService.execute(actor, {
        renter,
        watch,
        rentalPrice,
        city,
        zipCode,
        renterKyc,
        watchInsurance,
        renterTier,
        recentRentalTimestamps,
        exposureSnapshot: allWatchRentals,
        exposureConfig: this.exposureConfig,
        renterFreezeCases,
        watchFreezeCases,
        watchOpenClaims,
        now,
      });

      // 9. Save rental and review case
      await this.rentalRepo.save(result.rental);
      if (result.reviewCase) {
        await this.reviewRepo.save(result.reviewCase);
      }

      // 10. Respond
      res.status(201).json({
        rental: {
          id: result.rental.id,
          renterId: result.rental.renterId,
          watchId: result.rental.watchId,
          rentalPrice: result.rental.rentalPrice,
          escrowStatus: result.rental.escrowStatus,
          externalPaymentIntentId: result.rental.externalPaymentIntentId,
        },
        riskSignals: result.riskSignals.map((s) => ({
          code: s.code,
          severity: s.severity,
          message: s.message,
        })),
        reviewCaseId: result.reviewCase?.id ?? null,
      });
    } catch (error) {
      sendError(res, error);
    }
  }

  /**
   * Compute a platform-wide exposure snapshot from all active rentals.
   * In production this would be cached or pre-computed; here we
   * compute it from the in-memory store on each request.
   */
  private async computeExposureSnapshot(): Promise<ExposureSnapshot> {
    // This is a simplified approach: we'd need all active rentals across
    // the platform. Since we lack a "findAllActive" repo method, we
    // return a zero snapshot. The exposure engine will still enforce
    // config-level limits on the proposed rental.
    //
    // A real implementation would query a materialized view or
    // aggregation endpoint. This is an acknowledged structural gap
    // documented for the next phase.
    return {
      totalActiveWatchValue: 0,
      totalInsuranceCoverage: 0,
      activeRentalCount: 0,
    };
  }
}
