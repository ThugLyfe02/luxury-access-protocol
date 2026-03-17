import jwt from 'jsonwebtoken';
import { MarketplaceRole } from '../domain/enums/MarketplaceRole';
import { AuthenticatedActor } from './types/AuthenticatedActor';
import { AuthConfig } from './AuthConfig';

const VALID_ROLES: ReadonlySet<string> = new Set(Object.values(MarketplaceRole));

/**
 * JWT token claims structure.
 * sub = userId, role = MarketplaceRole, email = optional.
 */
interface JwtClaims {
  sub: string;
  role: string;
  email?: string;
  jti?: string;
}

/**
 * JWT-based token service.
 * - Fixed algorithm (HS256) — never inferred from token header
 * - Strict claim validation
 * - Issuer and audience verification
 * - Produces AuthenticatedActor from verified claims
 */
export class JwtTokenService {
  private readonly secret: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly expiresInSeconds: number;

  constructor(config: AuthConfig) {
    this.secret = config.jwtSecret;
    this.issuer = config.jwtIssuer;
    this.audience = config.jwtAudience;
    this.expiresInSeconds = config.jwtExpiresInSeconds;
  }

  /**
   * Issue a signed JWT for a user.
   */
  sign(params: { userId: string; role: MarketplaceRole; email?: string; tokenId?: string }): string {
    const payload: JwtClaims = {
      sub: params.userId,
      role: params.role,
      ...(params.email ? { email: params.email } : {}),
      ...(params.tokenId ? { jti: params.tokenId } : {}),
    };

    return jwt.sign(payload, this.secret, {
      algorithm: 'HS256',
      issuer: this.issuer,
      audience: this.audience,
      expiresIn: this.expiresInSeconds,
    });
  }

  /**
   * Verify a JWT and extract the authenticated actor.
   * Returns null if verification fails for any reason.
   * Never throws — callers check for null to determine auth failure.
   *
   * Failure modes:
   * - malformed token
   * - invalid signature
   * - expired token
   * - wrong issuer/audience
   * - missing required claims (sub, role)
   * - invalid role value
   */
  verify(token: string): { actor: AuthenticatedActor; reason?: undefined } | { actor?: undefined; reason: string } {
    let decoded: jwt.JwtPayload;
    try {
      const result = jwt.verify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      });

      if (typeof result === 'string') {
        return { reason: 'invalid_token_format' };
      }
      decoded = result;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return { reason: 'token_expired' };
      }
      if (err instanceof jwt.JsonWebTokenError) {
        return { reason: 'invalid_token' };
      }
      return { reason: 'verification_failed' };
    }

    // Validate required claims
    const sub = decoded.sub;
    if (typeof sub !== 'string' || sub.trim() === '') {
      return { reason: 'missing_sub_claim' };
    }

    const role = decoded.role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return { reason: 'invalid_role_claim' };
    }

    const email = typeof decoded.email === 'string' ? decoded.email : undefined;
    const tokenId = typeof decoded.jti === 'string' ? decoded.jti : undefined;

    return {
      actor: {
        userId: sub,
        role: role as MarketplaceRole,
        email,
        authSource: 'jwt',
        tokenId,
      },
    };
  }
}
