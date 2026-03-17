import { MarketplaceRole } from '../../domain/enums/MarketplaceRole';

/**
 * Authenticated actor context derived from a verified bearer token.
 *
 * This is the ONLY source of caller identity for protected routes.
 * Never derived from request body, params, or untrusted headers.
 */
export interface AuthenticatedActor {
  readonly userId: string;
  readonly role: MarketplaceRole;
  readonly email?: string;
  readonly authSource: 'jwt' | 'internal-token';
  readonly tokenId?: string;
}
