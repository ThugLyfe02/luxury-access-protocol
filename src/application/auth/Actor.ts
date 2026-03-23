import { MarketplaceRole } from '../../domain/enums/MarketplaceRole';

/**
 * Discriminated union representing a caller's identity context.
 *
 * UserActor: an authenticated marketplace participant (renter, owner, admin).
 * SystemActor: an internal system process or external webhook callback
 *   (e.g., Stripe webhook, background scheduler). Has no user identity.
 */
export type Actor = UserActor | SystemActor;

export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
  readonly role: MarketplaceRole;
}

export interface SystemActor {
  readonly kind: 'system';
  readonly source: string;
}
