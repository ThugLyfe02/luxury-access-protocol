import { DomainError } from '../errors/DomainError';

export type FreezableEntityType = 'USER' | 'WATCH' | 'RENTAL';

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set(['USER', 'WATCH', 'RENTAL']);

export class SystemFreeze {
  readonly id: string;
  readonly entityType: FreezableEntityType;
  readonly entityId: string;
  readonly reason: string;
  readonly frozenBy: string;
  readonly createdAt: Date;
  private _active: boolean;

  private constructor(params: {
    id: string;
    entityType: FreezableEntityType;
    entityId: string;
    reason: string;
    frozenBy: string;
    createdAt: Date;
    active: boolean;
  }) {
    this.id = params.id;
    this.entityType = params.entityType;
    this.entityId = params.entityId;
    this.reason = params.reason;
    this.frozenBy = params.frozenBy;
    this.createdAt = params.createdAt;
    this._active = params.active;
  }

  static create(params: {
    id: string;
    entityType: FreezableEntityType;
    entityId: string;
    reason: string;
    frozenBy: string;
    createdAt: Date;
  }): SystemFreeze {
    if (!params.id) {
      throw new DomainError('Freeze ID is required', 'FROZEN_ENTITY');
    }
    if (!VALID_ENTITY_TYPES.has(params.entityType)) {
      throw new DomainError(
        `Invalid entity type for freeze: ${params.entityType}`,
        'FROZEN_ENTITY',
      );
    }
    if (!params.entityId) {
      throw new DomainError('Entity ID is required for freeze', 'FROZEN_ENTITY');
    }
    if (!params.reason) {
      throw new DomainError('Freeze reason is required', 'FROZEN_ENTITY');
    }
    if (!params.frozenBy) {
      throw new DomainError('Frozen by actor ID is required', 'FROZEN_ENTITY');
    }

    return new SystemFreeze({
      ...params,
      active: true,
    });
  }

  static restore(params: {
    id: string;
    entityType: string;
    entityId: string;
    reason: string;
    frozenBy: string;
    createdAt: Date;
    active: boolean;
  }): SystemFreeze {
    if (!VALID_ENTITY_TYPES.has(params.entityType)) {
      throw new DomainError(
        `Unknown entity type from persistence: ${params.entityType}`,
        'FROZEN_ENTITY',
      );
    }

    return new SystemFreeze({
      ...params,
      entityType: params.entityType as FreezableEntityType,
    });
  }

  get active(): boolean {
    return this._active;
  }

  deactivate(): void {
    if (!this._active) {
      throw new DomainError(
        'Freeze is already inactive',
        'INVALID_STATE_TRANSITION',
      );
    }
    this._active = false;
  }
}
