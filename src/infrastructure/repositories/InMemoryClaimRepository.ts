import { InsuranceClaim } from '../../domain/entities/InsuranceClaim';
import { InsuranceClaimStatus } from '../../domain/enums/InsuranceClaimStatus';
import { ClaimRepository } from '../../domain/interfaces/ClaimRepository';
import { DomainError } from '../../domain/errors/DomainError';

interface ClaimRecord {
  readonly id: string;
  readonly policyId: string;
  readonly rentalId: string;
  readonly watchId: string;
  readonly claimAmount: number;
  readonly reason: string;
  readonly filedAt: string;
  readonly status: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly paidOutAt: string | null;
  readonly payoutAmount: number | null;
  readonly denialReason: string | null;
  readonly version: number;
}

function toRecord(claim: InsuranceClaim): ClaimRecord {
  return {
    id: claim.id,
    policyId: claim.policyId,
    rentalId: claim.rentalId,
    watchId: claim.watchId,
    claimAmount: claim.claimAmount,
    reason: claim.reason,
    filedAt: claim.filedAt.toISOString(),
    status: claim.status,
    reviewedBy: claim.reviewedBy,
    reviewedAt: claim.reviewedAt?.toISOString() ?? null,
    paidOutAt: claim.paidOutAt?.toISOString() ?? null,
    payoutAmount: claim.payoutAmount,
    denialReason: claim.denialReason,
    version: claim.version,
  };
}

function fromRecord(record: ClaimRecord): InsuranceClaim {
  return InsuranceClaim.restore({
    id: record.id,
    policyId: record.policyId,
    rentalId: record.rentalId,
    watchId: record.watchId,
    claimAmount: record.claimAmount,
    reason: record.reason,
    filedAt: new Date(record.filedAt),
    status: record.status,
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt !== null ? new Date(record.reviewedAt) : null,
    paidOutAt: record.paidOutAt !== null ? new Date(record.paidOutAt) : null,
    payoutAmount: record.payoutAmount,
    denialReason: record.denialReason,
    version: record.version,
  });
}

/** Enum-safe open status set — matches InsuranceClaim.isOpen() semantics */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  InsuranceClaimStatus.FILED,
  InsuranceClaimStatus.UNDER_REVIEW,
  InsuranceClaimStatus.APPROVED,
]);

export class InMemoryClaimRepository implements ClaimRepository {
  private readonly store = new Map<string, ClaimRecord>();

  async findById(id: string): Promise<InsuranceClaim | null> {
    const record = this.store.get(id);
    return record ? fromRecord(record) : null;
  }

  async findByRentalId(rentalId: string): Promise<InsuranceClaim[]> {
    const results: InsuranceClaim[] = [];
    for (const record of this.store.values()) {
      if (record.rentalId === rentalId) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findByWatchId(watchId: string): Promise<InsuranceClaim[]> {
    const results: InsuranceClaim[] = [];
    for (const record of this.store.values()) {
      if (record.watchId === watchId) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findOpenByWatchId(watchId: string): Promise<InsuranceClaim[]> {
    const results: InsuranceClaim[] = [];
    for (const record of this.store.values()) {
      if (record.watchId === watchId && OPEN_STATUSES.has(record.status)) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findOpenByRentalId(rentalId: string): Promise<InsuranceClaim[]> {
    const results: InsuranceClaim[] = [];
    for (const record of this.store.values()) {
      if (record.rentalId === rentalId && OPEN_STATUSES.has(record.status)) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async save(claim: InsuranceClaim): Promise<void> {
    const existing = this.store.get(claim.id);
    if (existing) {
      if (existing.version !== claim.version - 1) {
        throw new DomainError(
          `Claim version conflict: expected stored version ${claim.version - 1}, found ${existing.version}`,
          'VERSION_CONFLICT',
        );
      }
    }
    this.store.set(claim.id, toRecord(claim));
  }
}
