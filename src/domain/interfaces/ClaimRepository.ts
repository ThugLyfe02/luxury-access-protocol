import { InsuranceClaim } from '../entities/InsuranceClaim';

export interface ClaimRepository {
  findById(id: string): Promise<InsuranceClaim | null>;
  findByRentalId(rentalId: string): Promise<InsuranceClaim[]>;
  findByWatchId(watchId: string): Promise<InsuranceClaim[]>;
  findOpenByWatchId(watchId: string): Promise<InsuranceClaim[]>;

  /**
   * Persist the claim. Uses optimistic concurrency: if the stored
   * version does not match the claim's version at load time, the save
   * is rejected with VERSION_CONFLICT. New claims are always accepted.
   */
  save(claim: InsuranceClaim): Promise<void>;
}
