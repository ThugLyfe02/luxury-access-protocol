import { SystemFreeze, FreezableEntityType } from '../../domain/entities/SystemFreeze';
import { FreezeRepository } from '../../domain/interfaces/FreezeRepository';
import { DomainError } from '../../domain/errors/DomainError';

interface FreezeRecord {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly reason: string;
  readonly frozenBy: string;
  readonly createdAt: string;
  readonly active: boolean;
}

function toRecord(freeze: SystemFreeze): FreezeRecord {
  return {
    id: freeze.id,
    entityType: freeze.entityType,
    entityId: freeze.entityId,
    reason: freeze.reason,
    frozenBy: freeze.frozenBy,
    createdAt: freeze.createdAt.toISOString(),
    active: freeze.active,
  };
}

function fromRecord(record: FreezeRecord): SystemFreeze {
  return SystemFreeze.restore({
    id: record.id,
    entityType: record.entityType,
    entityId: record.entityId,
    reason: record.reason,
    frozenBy: record.frozenBy,
    createdAt: new Date(record.createdAt),
    active: record.active,
  });
}

export class InMemoryFreezeRepository implements FreezeRepository {
  private readonly store = new Map<string, FreezeRecord>();

  async create(freeze: SystemFreeze): Promise<void> {
    if (this.store.has(freeze.id)) {
      throw new DomainError(
        `Freeze ${freeze.id} already exists`,
        'DUPLICATE_REQUEST',
      );
    }
    this.store.set(freeze.id, toRecord(freeze));
  }

  async findActive(
    entityType: FreezableEntityType,
    entityId: string,
  ): Promise<SystemFreeze[]> {
    const results: SystemFreeze[] = [];
    for (const record of this.store.values()) {
      if (
        record.active &&
        record.entityType === entityType &&
        record.entityId === entityId
      ) {
        results.push(fromRecord(record));
      }
    }
    return results;
  }

  async findById(id: string): Promise<SystemFreeze | null> {
    const record = this.store.get(id);
    return record ? fromRecord(record) : null;
  }

  async save(freeze: SystemFreeze): Promise<void> {
    this.store.set(freeze.id, toRecord(freeze));
  }
}
