import { ManualReviewCase } from '../entities/ManualReviewCase';

export interface ReviewRepository {
  findById(id: string): Promise<ManualReviewCase | null>;
  findByRentalId(rentalId: string): Promise<ManualReviewCase[]>;
  findUnresolvedByRentalId(rentalId: string): Promise<ManualReviewCase[]>;

  /**
   * Find all unresolved review cases that freeze a specific entity.
   * Used by ReviewFreezePolicy to check user/watch/rental freeze status.
   */
  findUnresolvedByFreezeTarget(
    entityType: string,
    entityId: string,
  ): Promise<ManualReviewCase[]>;

  /**
   * Persist the review case. Uses optimistic concurrency: if the stored
   * version does not match the case's version at load time, the save is
   * rejected with VERSION_CONFLICT. New cases are always accepted.
   */
  save(reviewCase: ManualReviewCase): Promise<void>;
}
