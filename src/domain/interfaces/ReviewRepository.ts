import { ManualReviewCase } from '../entities/ManualReviewCase';

export interface ReviewRepository {
  findByRentalId(rentalId: string): Promise<ManualReviewCase[]>;
  findUnresolvedByRentalId(rentalId: string): Promise<ManualReviewCase[]>;
  save(reviewCase: ManualReviewCase): Promise<void>;
}
