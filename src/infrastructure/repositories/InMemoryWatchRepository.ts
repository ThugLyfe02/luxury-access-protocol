import { Watch } from '../../domain/entities/Watch';
import { WatchRepository } from '../../domain/interfaces/WatchRepository';

interface WatchRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly marketValue: number;
  readonly verificationStatus: string;
  readonly createdAt: string;
}

function toRecord(watch: Watch): WatchRecord {
  return {
    id: watch.id,
    ownerId: watch.ownerId,
    marketValue: watch.marketValue,
    verificationStatus: watch.verificationStatus,
    createdAt: watch.createdAt.toISOString(),
  };
}

function fromRecord(record: WatchRecord): Watch {
  return Watch.restore({
    id: record.id,
    ownerId: record.ownerId,
    marketValue: record.marketValue,
    verificationStatus: record.verificationStatus,
    createdAt: new Date(record.createdAt),
  });
}

export class InMemoryWatchRepository implements WatchRepository {
  private readonly store = new Map<string, WatchRecord>();

  async findById(id: string): Promise<Watch | null> {
    const record = this.store.get(id);
    if (!record) return null;
    return fromRecord(record);
  }

  async findByOwnerId(ownerId: string): Promise<Watch[]> {
    const results: Watch[] = [];
    for (const record of this.store.values()) {
      if (record.ownerId === ownerId) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async save(watch: Watch): Promise<void> {
    this.store.set(watch.id, toRecord(watch));
  }
}
