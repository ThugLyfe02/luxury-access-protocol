import { DomainError } from '../../domain/errors/DomainError';
import { Rental } from '../../domain/entities/Rental';
import { ManualReviewCase } from '../../domain/entities/ManualReviewCase';
import { InsuranceClaim } from '../../domain/entities/InsuranceClaim';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { ReviewRepository } from '../../domain/interfaces/ReviewRepository';
import { ClaimRepository } from '../../domain/interfaces/ClaimRepository';
import { ReviewFreezePolicy, FreezeCheckResult } from '../../domain/services/ReviewFreezePolicy';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';

/**
 * Structured view of a rental's current state and all active blockers.
 * This is a read-only inspection result — no mutations.
 */
export interface RentalInspectionResult {
  readonly rental: Rental;
  readonly escrowStatus: EscrowStatus;
  readonly isTerminal: boolean;
  readonly returnConfirmed: boolean;
  readonly disputeOpen: boolean;
  readonly externalPaymentIntentId: string | null;

  /** Whether a release is currently possible, and if not, why. */
  readonly releaseBlocked: boolean;
  readonly releaseBlockReasons: string[];

  /** Freeze status from review cases. */
  readonly freezeCheck: FreezeCheckResult;

  /** Unresolved review cases for this rental. */
  readonly unresolvedReviewCases: ManualReviewCase[];

  /** Open insurance claims on this rental or its watch. */
  readonly openClaimsOnRental: InsuranceClaim[];
  readonly openClaimsOnWatch: InsuranceClaim[];
}

/**
 * Application service for admin inspection of rentals.
 *
 * Provides a structured diagnostic view of a rental's state,
 * including all active blockers that would prevent fund release.
 *
 * Read-only. No state mutations. Admin-only access.
 */
export class AdminRentalInspectionService {
  private readonly rentalRepo: RentalRepository;
  private readonly reviewRepo: ReviewRepository;
  private readonly claimRepo: ClaimRepository;

  constructor(deps: {
    rentalRepo: RentalRepository;
    reviewRepo: ReviewRepository;
    claimRepo: ClaimRepository;
  }) {
    this.rentalRepo = deps.rentalRepo;
    this.reviewRepo = deps.reviewRepo;
    this.claimRepo = deps.claimRepo;
  }

  /**
   * Inspect a rental by ID. Returns a structured view of the rental's
   * state and all active blockers.
   */
  async inspectRental(actor: Actor, rentalId: string): Promise<RentalInspectionResult> {
    AuthorizationGuard.requireAdmin(actor);

    const rental = await this.rentalRepo.findById(rentalId);
    if (!rental) {
      throw new DomainError(
        `Rental ${rentalId} not found`,
        'INVALID_STATE_TRANSITION',
      );
    }

    // Load all blocking data in parallel
    const [unresolvedReviewCases, openClaimsOnRental, openClaimsOnWatch] =
      await Promise.all([
        this.reviewRepo.findUnresolvedByRentalId(rentalId),
        this.claimRepo.findByRentalId(rentalId).then((claims) =>
          claims.filter((c) => c.isOpen()),
        ),
        this.claimRepo.findOpenByWatchId(rental.watchId),
      ]);

    // Compute freeze check
    const freezeCheck = ReviewFreezePolicy.checkRentalFreeze(
      rentalId,
      unresolvedReviewCases,
    );

    // Compute release block reasons
    const releaseBlockReasons: string[] = [];

    if (rental.isTerminal()) {
      releaseBlockReasons.push(`Rental is in terminal state: ${rental.escrowStatus}`);
    }

    if (rental.escrowStatus !== EscrowStatus.EXTERNAL_PAYMENT_CAPTURED && !rental.isTerminal()) {
      releaseBlockReasons.push(`Payment not captured (current: ${rental.escrowStatus})`);
    }

    if (!rental.returnConfirmed) {
      releaseBlockReasons.push('Return not confirmed by watch owner');
    }

    if (rental.disputeOpen) {
      releaseBlockReasons.push('Dispute is open');
    }

    if (freezeCheck.frozen) {
      for (const reason of freezeCheck.reasons) {
        releaseBlockReasons.push(`Review freeze: ${reason}`);
      }
    }

    if (openClaimsOnRental.length > 0) {
      releaseBlockReasons.push(
        `${openClaimsOnRental.length} open insurance claim(s) on this rental`,
      );
    }

    if (openClaimsOnWatch.length > 0) {
      const watchOnlyClaims = openClaimsOnWatch.filter(
        (c) => c.rentalId !== rentalId,
      );
      if (watchOnlyClaims.length > 0) {
        releaseBlockReasons.push(
          `${watchOnlyClaims.length} open insurance claim(s) on this watch from other rentals`,
        );
      }
    }

    return {
      rental,
      escrowStatus: rental.escrowStatus,
      isTerminal: rental.isTerminal(),
      returnConfirmed: rental.returnConfirmed,
      disputeOpen: rental.disputeOpen,
      externalPaymentIntentId: rental.externalPaymentIntentId,
      releaseBlocked: releaseBlockReasons.length > 0,
      releaseBlockReasons,
      freezeCheck,
      unresolvedReviewCases,
      openClaimsOnRental,
      openClaimsOnWatch,
    };
  }

  /**
   * List all rentals for a specific renter.
   * Useful for investigating renter history.
   */
  async listRenterRentals(actor: Actor, renterId: string): Promise<Rental[]> {
    AuthorizationGuard.requireAdmin(actor);
    return this.rentalRepo.findByRenterId(renterId);
  }

  /**
   * List all rentals for a specific watch.
   * Useful for investigating watch history.
   */
  async listWatchRentals(actor: Actor, watchId: string): Promise<Rental[]> {
    AuthorizationGuard.requireAdmin(actor);
    return this.rentalRepo.findByWatchId(watchId);
  }
}
