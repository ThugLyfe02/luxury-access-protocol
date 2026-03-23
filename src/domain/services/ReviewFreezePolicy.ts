import { DomainError } from '../errors/DomainError';
import { ManualReviewCase } from '../entities/ManualReviewCase';

/**
 * Result of a freeze check — explains why an entity is frozen.
 */
export interface FreezeCheckResult {
  readonly frozen: boolean;
  readonly blockingCases: ReadonlyArray<ManualReviewCase>;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Domain service that determines whether entities are frozen by
 * open review cases and enforces freeze-based hard stops.
 *
 * Freeze semantics:
 * - An entity is frozen if any open HIGH or CRITICAL review case
 *   targets it (via freezeTargets) or is associated with its rental.
 * - Freeze blocks: rental initiation (for user/watch), fund release (for rental).
 * - Freeze is a hard stop, not advisory.
 */
export class ReviewFreezePolicy {
  /**
   * Check whether a specific entity is frozen by any of the given cases.
   * Cases are filtered to only open, blocking cases that target the entity.
   */
  static checkFreeze(
    entityType: string,
    entityId: string,
    cases: ManualReviewCase[],
  ): FreezeCheckResult {
    const blockingCases = cases.filter(
      (c) => c.isBlocking() && c.freezesEntity(entityType, entityId),
    );

    return {
      frozen: blockingCases.length > 0,
      blockingCases,
      reasons: blockingCases.map(
        (c) => `Case ${c.id} (${c.severity}): ${c.reason}`,
      ),
    };
  }

  /**
   * Check whether a rental is frozen — either by a case that directly
   * targets it via freezeTargets, or by any open blocking case
   * associated with the rental's ID.
   */
  static checkRentalFreeze(
    rentalId: string,
    cases: ManualReviewCase[],
  ): FreezeCheckResult {
    const blockingCases = cases.filter(
      (c) => c.isBlocking() && (
        c.rentalId === rentalId ||
        c.freezesEntity('Rental', rentalId)
      ),
    );

    return {
      frozen: blockingCases.length > 0,
      blockingCases,
      reasons: blockingCases.map(
        (c) => `Case ${c.id} (${c.severity}): ${c.reason}`,
      ),
    };
  }

  /**
   * Hard stop: assert that a user is not frozen.
   * Throws REVIEW_REQUIRED if the user has any open blocking review case.
   */
  static assertUserNotFrozen(
    userId: string,
    cases: ManualReviewCase[],
  ): void {
    const result = ReviewFreezePolicy.checkFreeze('User', userId, cases);
    if (result.frozen) {
      throw new DomainError(
        `User ${userId} is frozen by open review case: ${result.reasons[0]}`,
        'REVIEW_REQUIRED',
      );
    }
  }

  /**
   * Hard stop: assert that a watch is not frozen.
   * Throws REVIEW_REQUIRED if the watch has any open blocking review case.
   */
  static assertWatchNotFrozen(
    watchId: string,
    cases: ManualReviewCase[],
  ): void {
    const result = ReviewFreezePolicy.checkFreeze('Watch', watchId, cases);
    if (result.frozen) {
      throw new DomainError(
        `Watch ${watchId} is frozen by open review case: ${result.reasons[0]}`,
        'REVIEW_REQUIRED',
      );
    }
  }

  /**
   * Hard stop: assert that a rental is not frozen for release.
   * Throws REVIEW_REQUIRED if the rental has any open blocking review case.
   */
  static assertRentalNotFrozenForRelease(
    rentalId: string,
    cases: ManualReviewCase[],
  ): void {
    const result = ReviewFreezePolicy.checkRentalFreeze(rentalId, cases);
    if (result.frozen) {
      throw new DomainError(
        `Rental ${rentalId} is frozen by open review case: ${result.reasons[0]}`,
        'REVIEW_REQUIRED',
      );
    }
  }
}
