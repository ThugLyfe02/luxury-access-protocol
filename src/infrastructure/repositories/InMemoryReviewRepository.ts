import { ManualReviewCase } from '../../domain/entities/ManualReviewCase';
import { ReviewRepository } from '../../domain/interfaces/ReviewRepository';

interface ReviewRecord {
  readonly id: string;
  readonly rentalId: string;
  readonly severity: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly resolved: boolean;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

function toRecord(reviewCase: ManualReviewCase): ReviewRecord {
  return {
    id: reviewCase.id,
    rentalId: reviewCase.rentalId,
    severity: reviewCase.severity,
    reason: reviewCase.reason,
    createdAt: reviewCase.createdAt.toISOString(),
    resolved: reviewCase.resolved,
    resolvedBy: reviewCase.resolvedBy,
    resolvedAt: reviewCase.resolvedAt?.toISOString() ?? null,
    resolution: reviewCase.resolution,
  };
}

function fromRecord(record: ReviewRecord): ManualReviewCase {
  return ManualReviewCase.restore({
    id: record.id,
    rentalId: record.rentalId,
    severity: record.severity,
    reason: record.reason,
    createdAt: new Date(record.createdAt),
    resolved: record.resolved,
    resolvedBy: record.resolvedBy,
    resolvedAt: record.resolvedAt !== null ? new Date(record.resolvedAt) : null,
    resolution: record.resolution,
  });
}

export class InMemoryReviewRepository implements ReviewRepository {
  private readonly store = new Map<string, ReviewRecord>();

  async findByRentalId(rentalId: string): Promise<ManualReviewCase[]> {
    const results: ManualReviewCase[] = [];
    for (const record of this.store.values()) {
      if (record.rentalId === rentalId) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findUnresolvedByRentalId(rentalId: string): Promise<ManualReviewCase[]> {
    const results: ManualReviewCase[] = [];
    for (const record of this.store.values()) {
      if (record.rentalId === rentalId && !record.resolved) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async save(reviewCase: ManualReviewCase): Promise<void> {
    this.store.set(reviewCase.id, toRecord(reviewCase));
  }
}
