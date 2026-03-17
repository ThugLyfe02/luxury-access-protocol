import { Router, Request, Response, NextFunction } from 'express';
import { InitiateRentalService } from '../../application/services/InitiateRentalService';
import { UserActor } from '../../application/auth/Actor';
import { MarketplaceRole } from '../../domain/enums/MarketplaceRole';
import { UserRepository } from '../../domain/interfaces/UserRepository';
import { WatchRepository } from '../../domain/interfaces/WatchRepository';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { KycRepository } from '../../domain/interfaces/KycRepository';
import { InsuranceRepository } from '../../domain/interfaces/InsuranceRepository';
import { ClaimRepository } from '../../domain/interfaces/ClaimRepository';
import { ReviewRepository } from '../../domain/interfaces/ReviewRepository';
import { ExposureConfig } from '../../domain/services/PlatformExposureEngine';
import { TierEngine } from '../../domain/services/TierEngine';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { validateInitiateRental, validateRentalIdParam } from '../dto/validate';
import { presentRental } from '../presenters/presentRental';
import { successResponse, errorResponse } from '../dto/response';
import {
  IdempotencyStore,
  computePayloadHash,
} from '../idempotency/IdempotencyStore';
import { AuthenticatedActor } from '../../auth/types/AuthenticatedActor';

export interface RentalRouteDeps {
  initiateRentalService: InitiateRentalService;
  userRepo: UserRepository;
  watchRepo: WatchRepository;
  rentalRepo: RentalRepository;
  kycRepo: KycRepository;
  insuranceRepo: InsuranceRepository;
  claimRepo: ClaimRepository;
  reviewRepo: ReviewRepository;
  exposureConfig: ExposureConfig;
  idempotencyStore: IdempotencyStore;
}

export function createRentalRoutes(deps: RentalRouteDeps): Router {
  const router = Router();

  /**
   * POST /rentals/initiate
   *
   * Initiates a new rental.
   * Actor identity (renterId) comes from the verified JWT token — NOT the body.
   * Request body provides only resource/action inputs: watchId, rentalPrice, city, zipCode.
   */
  router.post('/rentals/initiate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = req.actor as AuthenticatedActor;

      // 1. Validate input (no renterId in body)
      const validated = validateInitiateRental(req.body);
      if (!validated.valid) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'Request validation failed',
          req.requestId,
          validated.errors,
        ));
        return;
      }

      const { watchId, rentalPrice, city, zipCode, idempotencyKey } = validated.value;

      // renterId is derived from authenticated actor — never from body
      const renterId = actor.userId;

      // 2. Idempotency check
      const effectiveIdempotencyKey = (req.headers['idempotency-key'] as string | undefined)
        ?? idempotencyKey;

      if (effectiveIdempotencyKey) {
        const existing = await deps.idempotencyStore.find(effectiveIdempotencyKey);
        if (existing) {
          const currentHash = computePayloadHash({ renterId, watchId, rentalPrice, city, zipCode });
          if (existing.payloadHash !== currentHash) {
            res.status(409).json(errorResponse(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key reused with different payload',
              req.requestId,
            ));
            return;
          }
          // Replay cached response
          res.status(existing.responseStatus).json(JSON.parse(existing.responseBody));
          return;
        }
      }

      // 3. Load entities
      const renter = await deps.userRepo.findById(renterId);
      if (!renter) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Renter not found', req.requestId));
        return;
      }

      const watch = await deps.watchRepo.findById(watchId);
      if (!watch) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Watch not found', req.requestId));
        return;
      }

      // 4. Load supporting data
      const renterKyc = await deps.kycRepo.findByUserId(renterId);
      const watchInsurance = await deps.insuranceRepo.findActiveByWatchId(watchId);

      // 5. Compute renter tier
      const renterRentals = await deps.rentalRepo.findByRenterId(renterId);
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

      // 6. Recent rental timestamps (velocity check)
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const recentRentalTimestamps = renterRentals
        .filter((r) => r.createdAt >= oneDayAgo)
        .map((r) => r.createdAt);

      // 7. Compute exposure snapshot
      const activeRentals = await deps.rentalRepo.findAllActive();
      let totalActiveWatchValue = 0;
      let totalInsuranceCoverage = 0;
      for (const rental of activeRentals) {
        const w = await deps.watchRepo.findById(rental.watchId);
        if (w) {
          totalActiveWatchValue += w.marketValue;
          const policy = await deps.insuranceRepo.findActiveByWatchId(rental.watchId);
          if (policy) totalInsuranceCoverage += policy.netCoverage();
        }
      }

      // 8. Load freeze/claim/active rental data
      const renterFreezeCases = await deps.reviewRepo.findUnresolvedByFreezeTarget('User', renterId);
      const watchFreezeCases = await deps.reviewRepo.findUnresolvedByFreezeTarget('Watch', watchId);
      const watchOpenClaims = await deps.claimRepo.findOpenByWatchId(watchId);
      const watchActiveRentals = await deps.rentalRepo.findByWatchId(watchId);

      // 9. Build domain actor from verified auth context
      const domainActor: UserActor = {
        kind: 'user',
        userId: renterId,
        role: actor.role,
      };

      // 10. Execute
      const result = await deps.initiateRentalService.execute(domainActor, {
        idempotencyKey: effectiveIdempotencyKey,
        renter,
        watch,
        rentalPrice,
        city,
        zipCode,
        renterKyc,
        watchInsurance,
        renterTier,
        recentRentalTimestamps,
        exposureSnapshot: {
          totalActiveWatchValue,
          totalInsuranceCoverage,
          activeRentalCount: activeRentals.length,
        },
        exposureConfig: deps.exposureConfig,
        renterFreezeCases,
        watchFreezeCases,
        watchOpenClaims,
        watchActiveRentals,
        now,
      });

      // 11. Persist
      await deps.rentalRepo.save(result.rental);
      if (result.reviewCase) {
        await deps.reviewRepo.save(result.reviewCase);
      }

      // 12. Build response
      const responseBody = successResponse({
        rental: presentRental(result.rental),
        riskSignals: result.riskSignals.map((s) => ({
          code: s.code,
          severity: s.severity,
          message: s.message,
        })),
        reviewCaseId: result.reviewCase?.id ?? null,
      }, req.requestId);

      // 13. Cache for idempotency
      if (effectiveIdempotencyKey) {
        await deps.idempotencyStore.save({
          key: effectiveIdempotencyKey,
          payloadHash: computePayloadHash({ renterId, watchId, rentalPrice, city, zipCode }),
          responseStatus: 201,
          responseBody: JSON.stringify(responseBody),
          createdAt: now,
        });
      }

      res.status(201).json(responseBody);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /rentals/:id
   *
   * Returns a rental by ID.
   * Authorization: actor must be the renter, the watch owner, or an admin.
   */
  router.get('/rentals/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = req.actor as AuthenticatedActor;

      const validated = validateRentalIdParam(req.params as Record<string, string>);
      if (!validated.valid) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'Invalid rental ID',
          req.requestId,
          validated.errors,
        ));
        return;
      }

      const rental = await deps.rentalRepo.findById(validated.value.rentalId);
      if (!rental) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Rental not found', req.requestId));
        return;
      }

      // Authorization: renter, watch owner, or admin
      if (actor.role !== MarketplaceRole.ADMIN) {
        const isRenter = actor.userId === rental.renterId;
        if (!isRenter) {
          // Check if actor is the watch owner
          const watch = await deps.watchRepo.findById(rental.watchId);
          const isOwner = watch !== null && actor.userId === watch.ownerId;
          if (!isOwner) {
            res.status(403).json(errorResponse(
              'FORBIDDEN',
              'You do not have access to this rental',
              req.requestId,
            ));
            return;
          }
        }
      }

      res.status(200).json(successResponse({ rental: presentRental(rental) }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
