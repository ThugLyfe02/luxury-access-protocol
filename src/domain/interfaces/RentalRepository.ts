import { Rental } from '../entities/Rental';

export interface RentalRepository {
  findById(id: string): Promise<Rental | null>;
  findByExternalPaymentIntentId(intentId: string): Promise<Rental | null>;
  findByRenterId(renterId: string): Promise<Rental[]>;
  findByWatchId(watchId: string): Promise<Rental[]>;
  save(rental: Rental): Promise<void>;
}
