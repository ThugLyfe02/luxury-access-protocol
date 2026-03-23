import { ManualReviewCase } from '../entities/ManualReviewCase';

/**
 * Repository contract for manual review cases used by
 * the operational control plane.
 *
 * Extends the existing ReviewRepository contract with
 * the create + findOpenByEntity methods required by Phase G.
 */
export interface ManualReviewRepository {
  create(reviewCase: ManualReviewCase): Promise<void>;
  findOpenByEntity(entityType: string, entityId: string): Promise<ManualReviewCase[]>;
  findById(id: string): Promise<ManualReviewCase | null>;
  save(reviewCase: ManualReviewCase): Promise<void>;
}
