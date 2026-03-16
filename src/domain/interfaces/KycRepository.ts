import { KycProfile } from '../entities/KycProfile';

export interface KycRepository {
  findByUserId(userId: string): Promise<KycProfile | null>;
  save(profile: KycProfile): Promise<void>;
}
