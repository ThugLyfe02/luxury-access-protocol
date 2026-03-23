import { DomainError } from '../../domain/errors/DomainError';
import { MarketplaceRole } from '../../domain/enums/MarketplaceRole';
import { Actor, UserActor, SystemActor } from './Actor';

/**
 * Static authorization assertions for application-layer service boundaries.
 *
 * These guards enforce caller identity and role requirements.
 * Domain entities enforce state/invariants — these guards enforce
 * "who is allowed to attempt this operation."
 */
export class AuthorizationGuard {
  /**
   * Require that the actor is an authenticated user (not a system process).
   * Returns the narrowed UserActor for downstream checks.
   */
  static requireUser(actor: Actor): UserActor {
    if (actor.kind !== 'user') {
      throw new DomainError(
        'This operation requires an authenticated user',
        'UNAUTHORIZED',
      );
    }
    return actor;
  }

  /**
   * Require that the actor is a system process (e.g., webhook handler).
   * Returns the narrowed SystemActor.
   */
  static requireSystem(actor: Actor): SystemActor {
    if (actor.kind !== 'system') {
      throw new DomainError(
        'This operation is restricted to system processes',
        'UNAUTHORIZED',
      );
    }
    return actor;
  }

  /**
   * Require that the actor is a user with one of the specified roles.
   */
  static requireRole(actor: Actor, ...roles: MarketplaceRole[]): UserActor {
    const user = AuthorizationGuard.requireUser(actor);
    if (!roles.includes(user.role)) {
      throw new DomainError(
        `This operation requires one of the following roles: ${roles.join(', ')}`,
        'UNAUTHORIZED',
      );
    }
    return user;
  }

  /**
   * Require that the actor is the specific user identified by targetUserId.
   * Rejects system actors and mismatched user actors.
   */
  static requireSelf(actor: Actor, targetUserId: string): UserActor {
    const user = AuthorizationGuard.requireUser(actor);
    if (user.userId !== targetUserId) {
      throw new DomainError(
        'You are not authorized to act on behalf of another user',
        'UNAUTHORIZED',
      );
    }
    return user;
  }

  /**
   * Require that the actor is either the specific user or an admin.
   */
  static requireSelfOrAdmin(actor: Actor, targetUserId: string): UserActor {
    const user = AuthorizationGuard.requireUser(actor);
    if (user.userId !== targetUserId && user.role !== MarketplaceRole.ADMIN) {
      throw new DomainError(
        'You are not authorized to act on behalf of another user',
        'UNAUTHORIZED',
      );
    }
    return user;
  }

  /**
   * Require that the actor is an admin user.
   */
  static requireAdmin(actor: Actor): UserActor {
    return AuthorizationGuard.requireRole(actor, MarketplaceRole.ADMIN);
  }

  /**
   * Require that the actor is either a system process or an admin user.
   * Used for operations that can be triggered by webhooks or admin actions.
   */
  static requireSystemOrAdmin(actor: Actor): Actor {
    if (actor.kind === 'system') return actor;
    if (actor.kind === 'user' && actor.role === MarketplaceRole.ADMIN) return actor;
    throw new DomainError(
      'This operation is restricted to system processes or administrators',
      'UNAUTHORIZED',
    );
  }

  /**
   * Assert that the authenticated user is NOT the owner of the target resource.
   * Prevents self-dealing (e.g., renting your own watch).
   */
  static rejectSelfOwned(actor: Actor, ownerId: string): void {
    if (actor.kind === 'user' && actor.userId === ownerId) {
      throw new DomainError(
        'You cannot perform this operation on your own resource',
        'UNAUTHORIZED',
      );
    }
  }
}
