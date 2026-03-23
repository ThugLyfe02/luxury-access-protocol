import { Watch } from '../entities/Watch';

export interface WatchRepository {
  findById(id: string): Promise<Watch | null>;
  findByOwnerId(ownerId: string): Promise<Watch[]>;
  save(watch: Watch): Promise<void>;
}
