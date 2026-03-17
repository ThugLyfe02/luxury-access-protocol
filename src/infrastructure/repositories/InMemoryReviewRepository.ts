import { ManualReviewCase, FreezeTarget } from '../../domain/entities/ManualReviewCase';
import { ReviewRepository } from '../../domain/interfaces/ReviewRepository';
import { DomainError } from '../../domain/errors/DomainError';

interface ReviewRecord {
  readonly id: string;
  readonly rentalId: string;
  readonly severity: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
  readonly version: number;
  readonly freezeTargets: FreezeTarget[];
  readonly slaDeadline: string;
}

function toRecord(reviewCase: ManualReviewCase): ReviewRecord {
  return {
    id: reviewCase.id,
    rentalId: reviewCase.rentalId,
    severity: reviewCase.severity,
    reason: reviewCase.reason,
    createdAt: reviewCase.createdAt.toISOString(),
    status: reviewCase.status,
    assignedTo: reviewCase.assignedTo,
    resolvedBy: reviewCase.resolvedBy,
    resolvedAt: reviewCase.resolvedAt?.toISOString() ?? null,
    resolution: reviewCase.resolution,
    version: reviewCase.version,
    freezeTargets: [...reviewCase.freezeTargets],
    slaDeadline: reviewCase.slaDeadline.toISOString(),
  };
}

function fromRecord(record: ReviewRecord): ManualReviewCase {
  return ManualReviewCase.restore({
    id: record.id,
    rentalId: record.rentalId,
    severity: record.severity,
    reason: record.reason,
    createdAt: new Date(record.createdAt),
    status: record.status,
    assignedTo: record.assignedTo,
    resolvedBy: record.resolvedBy,
    resolvedAt: record.resolvedAt !== null ? new Date(record.resolvedAt) : null,
    resolution: record.resolution,
    version: record.version,
    freezeTargets: record.freezeTargets,
    slaDeadline: new Date(record.slaDeadline),
  });
}

export class InMemoryReviewRepository implements ReviewRepository {
  private readonly store = new Map<string, ReviewRecord>();

  async findById(id: string): Promise<ManualReviewCase | null> {
    const record = this.store.get(id);
    return record ? fromRecord(record) : null;
  }

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
      if (record.rentalId === rentalId && !this.isTerminalStatus(record.status)) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findUnresolvedByFreezeTarget(
    entityType: string,
    entityId: string,
  ): Promise<ManualReviewCase[]> {
    const results: ManualReviewCase[] = [];
    for (const record of this.store.values()) {
      if (this.isTerminalStatus(record.status)) continue;
      const hasTarget = record.freezeTargets.some(
        (t) => t.entityType === entityType && t.entityId === entityId,
      );
      if (hasTarget) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async save(reviewCase: ManualReviewCase): Promise<void> {
    const existing = this.store.get(reviewCase.id);
    if (existing) {
      if (existing.version !== reviewCase.version - 1) {
        throw new DomainError(
          `Review case version conflict: expected stored version ${reviewCase.version - 1}, found ${existing.version}`,
          'VERSION_CONFLICT',
        );
      }
    }
    this.store.set(reviewCase.id, toRecord(reviewCase));
  }

  private isTerminalStatus(status: string): boolean {
    return status === 'APPROVED' || status === 'REJECTED';
  }
}
