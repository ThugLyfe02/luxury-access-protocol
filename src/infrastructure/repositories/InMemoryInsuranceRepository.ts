import { InsurancePolicy } from '../../domain/entities/InsurancePolicy';
import { InsurancePolicyStatus } from '../../domain/enums/InsurancePolicyStatus';
import { InsuranceRepository } from '../../domain/interfaces/InsuranceRepository';
import { DomainError } from '../../domain/errors/DomainError';

interface InsuranceRecord {
  readonly id: string;
  readonly watchId: string;
  readonly providerId: string;
  readonly coverageAmount: number;
  readonly deductible: number;
  readonly premiumPerRental: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly status: string;
  readonly createdAt: string;
  readonly version: number;
}

function toRecord(policy: InsurancePolicy): InsuranceRecord {
  return {
    id: policy.id,
    watchId: policy.watchId,
    providerId: policy.providerId,
    coverageAmount: policy.coverageAmount,
    deductible: policy.deductible,
    premiumPerRental: policy.premiumPerRental,
    effectiveFrom: policy.effectiveFrom.toISOString(),
    effectiveTo: policy.effectiveTo.toISOString(),
    status: policy.status,
    createdAt: policy.createdAt.toISOString(),
    version: policy.version,
  };
}

function fromRecord(record: InsuranceRecord): InsurancePolicy {
  return InsurancePolicy.restore({
    id: record.id,
    watchId: record.watchId,
    providerId: record.providerId,
    coverageAmount: record.coverageAmount,
    deductible: record.deductible,
    premiumPerRental: record.premiumPerRental,
    effectiveFrom: new Date(record.effectiveFrom),
    effectiveTo: new Date(record.effectiveTo),
    status: record.status,
    createdAt: new Date(record.createdAt),
    version: record.version,
  });
}

export class InMemoryInsuranceRepository implements InsuranceRepository {
  private readonly store = new Map<string, InsuranceRecord>();

  async findByWatchId(watchId: string): Promise<InsurancePolicy | null> {
    for (const record of this.store.values()) {
      if (record.watchId === watchId) {
        return fromRecord(record);
      }
    }
    return null;
  }

  async findActiveByWatchId(watchId: string): Promise<InsurancePolicy | null> {
    for (const record of this.store.values()) {
      if (
        record.watchId === watchId &&
        record.status === InsurancePolicyStatus.ACTIVE
      ) {
        return fromRecord(record);
      }
    }
    return null;
  }

  async save(policy: InsurancePolicy): Promise<void> {
    const existing = this.store.get(policy.id);
    if (existing) {
      if (existing.version !== policy.version - 1) {
        throw new DomainError(
          `Insurance policy version conflict: expected stored version ${policy.version - 1}, found ${existing.version}`,
          'VERSION_CONFLICT',
        );
      }
    }
    this.store.set(policy.id, toRecord(policy));
  }
}
