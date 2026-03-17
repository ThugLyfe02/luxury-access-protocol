/**
 * Auth configuration.
 * All required auth config must be present at startup for protected-mode runtime.
 */
export interface AuthConfig {
  /** Secret key for JWT signing and verification. Must be >= 32 characters. */
  readonly jwtSecret: string;
  /** JWT issuer claim. */
  readonly jwtIssuer: string;
  /** JWT audience claim. */
  readonly jwtAudience: string;
  /** Token expiration in seconds. Default: 3600 (1 hour). */
  readonly jwtExpiresInSeconds: number;
  /** Internal API token for admin/diagnostics routes. */
  readonly internalApiToken: string;
}

const MINIMUM_SECRET_LENGTH = 32;

/**
 * Load and validate auth config from environment.
 * Fails fast if required config is missing or invalid.
 */
export function loadAuthConfig(): AuthConfig {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be set and be at least ${MINIMUM_SECRET_LENGTH} characters`,
    );
  }

  const jwtIssuer = process.env.JWT_ISSUER ?? 'luxury-access-protocol';
  const jwtAudience = process.env.JWT_AUDIENCE ?? 'luxury-access-protocol';
  const jwtExpiresInSeconds = parseInt(process.env.JWT_EXPIRES_IN_SECONDS ?? '3600', 10);

  if (!Number.isFinite(jwtExpiresInSeconds) || jwtExpiresInSeconds <= 0) {
    throw new Error('JWT_EXPIRES_IN_SECONDS must be a positive integer');
  }

  const internalApiToken = process.env.INTERNAL_API_TOKEN;
  if (!internalApiToken || internalApiToken.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `INTERNAL_API_TOKEN must be set and be at least ${MINIMUM_SECRET_LENGTH} characters`,
    );
  }

  return {
    jwtSecret,
    jwtIssuer,
    jwtAudience,
    jwtExpiresInSeconds,
    internalApiToken,
  };
}
