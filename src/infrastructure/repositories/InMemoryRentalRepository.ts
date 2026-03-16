import { Rental } from '../../domain/entities/Rental';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';

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

  async save(rental: Rental): Promise<void> {
    this.store.set(rental.id, toRecord(rental));
  }
}
