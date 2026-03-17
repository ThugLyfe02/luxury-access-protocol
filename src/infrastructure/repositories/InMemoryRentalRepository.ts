import { Rental } from '../../domain/entities/Rental';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { DomainError } from '../../domain/errors/DomainError';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  EscrowStatus.FUNDS_RELEASED_TO_OWNER,
  EscrowStatus.REFUNDED,
]);

interface RentalRecord {
  readonly id: string;
  readonly renterId: string;
  readonly watchId: string;
  readonly rentalPrice: number;
  readonly escrowStatus: string;
  readonly externalPaymentIntentId: string | null;
  readonly returnConfirmed: boolean;
  readonly disputeOpen: boolean;
  readonly createdAt: string;
  readonly version: number;
}

function toRecord(rental: Rental): RentalRecord {
  return {
    id: rental.id,
    renterId: rental.renterId,
    watchId: rental.watchId,
    rentalPrice: rental.rentalPrice,
    escrowStatus: rental.escrowStatus,
    externalPaymentIntentId: rental.externalPaymentIntentId,
    returnConfirmed: rental.returnConfirmed,
    disputeOpen: rental.disputeOpen,
    createdAt: rental.createdAt.toISOString(),
    version: rental.version,
  };
}

function fromRecord(record: RentalRecord): Rental {
  return Rental.restore({
    id: record.id,
    renterId: record.renterId,
    watchId: record.watchId,
    rentalPrice: record.rentalPrice,
    escrowStatus: record.escrowStatus,
    externalPaymentIntentId: record.externalPaymentIntentId,
    returnConfirmed: record.returnConfirmed,
    disputeOpen: record.disputeOpen,
    createdAt: new Date(record.createdAt),
    version: record.version,
  });
}

export class InMemoryRentalRepository implements RentalRepository {
  private readonly store = new Map<string, RentalRecord>();

  async findById(id: string): Promise<Rental | null> {
    const record = this.store.get(id);
    if (!record) return null;
    return fromRecord(record);
  }

  async findByExternalPaymentIntentId(intentId: string): Promise<Rental | null> {
    for (const record of this.store.values()) {
      if (record.externalPaymentIntentId === intentId) {
        return fromRecord(record);
      }
    }
    return null;
  }

  async findByRenterId(renterId: string): Promise<Rental[]> {
    const results: Rental[] = [];
    for (const record of this.store.values()) {
      if (record.renterId === renterId) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findByWatchId(watchId: string): Promise<Rental[]> {
    const results: Rental[] = [];
    for (const record of this.store.values()) {
      if (record.watchId === watchId) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findActiveByWatchId(watchId: string): Promise<Rental[]> {
    const results: Rental[] = [];
    for (const record of this.store.values()) {
      if (record.watchId === watchId && !TERMINAL_STATUSES.has(record.escrowStatus)) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findAllActive(): Promise<Rental[]> {
    const results: Rental[] = [];
    for (const record of this.store.values()) {
      if (!TERMINAL_STATUSES.has(record.escrowStatus)) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async save(rental: Rental): Promise<void> {
    const existing = this.store.get(rental.id);
    if (existing) {
      // Optimistic concurrency: every entity mutation bumps the version by 1.
      // The stored version must equal entity.version - 1, meaning no other
      // write changed the stored record between load and save.
      if (existing.version !== rental.version - 1) {
        throw new DomainError(
          `Rental version conflict: expected stored version ${rental.version - 1}, found ${existing.version}`,
          'VERSION_CONFLICT',
        );
      }
    } else {
      // New rental INSERT — enforce double-rental prevention (matches Postgres
      // partial unique index behavior). At most one active rental per watch.
      for (const record of this.store.values()) {
        if (
          record.watchId === rental.watchId &&
          !TERMINAL_STATUSES.has(record.escrowStatus)
        ) {
          throw new DomainError(
            'Watch already has an active rental',
            'WATCH_ALREADY_RESERVED',
          );
        }
      }
    }
    this.store.set(rental.id, toRecord(rental));
  }
}
