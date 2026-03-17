import { ManualReviewCase } from '../entities/ManualReviewCase';

export interface ReviewRepository {
  findByRentalId(rentalId: string): Promise<ManualReviewCase[]>;
  findUnresolvedByRentalId(rentalId: string): Promise<ManualReviewCase[]>;
  /**
   * Persist the review case. Uses optimistic concurrency: if the stored
   * version does not match the case's version at load time, the save is
   * rejected with VERSION_CONFLICT. New cases are always accepted.
   */
  save(reviewCase: ManualReviewCase): Promise<void>;
}
