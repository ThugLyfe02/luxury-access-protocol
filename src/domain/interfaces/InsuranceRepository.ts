import { InsurancePolicy } from '../entities/InsurancePolicy';

export interface InsuranceRepository {
  findByWatchId(watchId: string): Promise<InsurancePolicy | null>;
  findActiveByWatchId(watchId: string): Promise<InsurancePolicy | null>;
  save(policy: InsurancePolicy): Promise<void>;
}
