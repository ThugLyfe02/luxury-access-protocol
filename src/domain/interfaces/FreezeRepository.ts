import { SystemFreeze, FreezableEntityType } from '../entities/SystemFreeze';

export interface FreezeRepository {
  create(freeze: SystemFreeze): Promise<void>;
  findActive(entityType: FreezableEntityType, entityId: string): Promise<SystemFreeze[]>;
  findById(id: string): Promise<SystemFreeze | null>;
  save(freeze: SystemFreeze): Promise<void>;
}
