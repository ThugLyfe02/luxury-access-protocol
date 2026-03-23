import { DomainError } from '../errors/DomainError';

/**
 * Domain service that triggers manual review requirements.
 *
 * When a condition warrants human review, this policy throws
 * MANUAL_REVIEW_REQUIRED to halt the operation. The caller is
 * responsible for creating the review case before the throw.
 */
export class ManualReviewPolicy {
  /**
   * If the condition is true, throw MANUAL_REVIEW_REQUIRED.
   * The caller should have already created the ManualReviewCase
   * before invoking this method.
   */
  static requireReviewIf(
    condition: boolean,
    entityType: string,
    entityId: string,
    reason: string,
  ): void {
    if (condition) {
      throw new DomainError(
        `Manual review required for ${entityType} ${entityId}: ${reason}`,
        'MANUAL_REVIEW_REQUIRED',
      );
    }
  }
}
