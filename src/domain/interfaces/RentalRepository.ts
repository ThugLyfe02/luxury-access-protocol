import { Rental } from '../entities/Rental';

export interface RentalRepository {
  findById(id: string): Promise<Rental | null>;
  findByExternalPaymentIntentId(intentId: string): Promise<Rental | null>;
  findByRenterId(renterId: string): Promise<Rental[]>;
  findByWatchId(watchId: string): Promise<Rental[]>;
  /**
   * Persist the rental. Uses optimistic concurrency: if the stored version
   * does not match the rental's version at load time, the save is rejected
   * with VERSION_CONFLICT. New rentals (not previously stored) are always accepted.
   */
  save(rental: Rental): Promise<void>;
}
