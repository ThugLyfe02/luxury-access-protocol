import { DomainError } from '../errors/DomainError';
import { SystemFreeze, FreezableEntityType } from '../entities/SystemFreeze';

/**
 * Domain service that enforces system-level freezes.
 *
 * A frozen entity cannot participate in any new business operations.
 * Freeze checks are hard stops — they throw FROZEN_ENTITY on violation.
 */
export class FreezePolicy {
  /**
   * Assert that an entity is not frozen by any active SystemFreeze.
   * Throws FROZEN_ENTITY if any active freeze exists.
   */
  static ensureNotFrozen(
    entityType: FreezableEntityType,
    entityId: string,
    activeFreezes: SystemFreeze[],
  ): void {
    const activeFreeze = activeFreezes.find(
      (f) => f.active && f.entityType === entityType && f.entityId === entityId,
    );

    if (activeFreeze) {
      throw new DomainError(
        `${entityType} ${entityId} is frozen: ${activeFreeze.reason}`,
        'FROZEN_ENTITY',
      );
    }
  }
}
