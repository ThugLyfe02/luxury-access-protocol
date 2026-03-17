import { JwtTokenService } from '../../src/auth/JwtTokenService';
import { AuthConfig } from '../../src/auth/AuthConfig';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';

/**
 * Stable test auth config — used by all HTTP integration tests.
 */
export const TEST_AUTH_CONFIG: AuthConfig = {
  jwtSecret: 'test-secret-key-must-be-at-least-32-characters-long',
  jwtIssuer: 'luxury-access-protocol',
  jwtAudience: 'luxury-access-protocol',
  jwtExpiresInSeconds: 3600,
  internalApiToken: 'internal-test-token-must-be-at-least-32-chars',
};

export const testTokenService = new JwtTokenService(TEST_AUTH_CONFIG);

/**
 * Issue a valid test JWT for the given user.
 */
export function signToken(userId: string, role: MarketplaceRole): string {
  return testTokenService.sign({ userId, role });
}

/**
 * Issue an expired token for testing.
 */
export function signExpiredToken(userId: string, role: MarketplaceRole): string {
  const svc = new JwtTokenService({
    ...TEST_AUTH_CONFIG,
    jwtExpiresInSeconds: -1, // already expired
  });
  return svc.sign({ userId, role });
}
