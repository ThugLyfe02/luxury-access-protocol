import { Request, Response, NextFunction } from 'express';
import { JwtTokenService } from '../JwtTokenService';
import { AuthenticatedActor } from '../types/AuthenticatedActor';
import { errorResponse } from '../../http/dto/response';

/**
 * Extend Express Request to carry verified actor context.
 */
declare global {
  namespace Express {
    interface Request {
      actor?: AuthenticatedActor;
    }
  }
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Extract bearer token from Authorization header.
 * Only accepts Authorization: Bearer <token>.
 * Never accepts token from query params, body, or other headers.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  if (!authHeader.startsWith(BEARER_PREFIX)) return null;
  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  if (token === '') return null;
  return token;
}

/**
 * Authentication middleware factory.
 * Verifies bearer JWT token and attaches AuthenticatedActor to request.
 * Fails closed: missing/invalid/expired tokens → 401.
 */
export function requireAuth(tokenService: JwtTokenService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      res.status(401).json(errorResponse(
        'UNAUTHORIZED',
        'Missing or malformed Authorization header',
        req.requestId,
      ));
      return;
    }

    const result = tokenService.verify(token);

    if (!result.actor) {
      const message = result.reason === 'token_expired'
        ? 'Token has expired'
        : 'Invalid authentication token';

      const code = result.reason === 'token_expired' ? 'TOKEN_EXPIRED' : 'INVALID_CREDENTIALS';

      res.status(401).json(errorResponse(code, message, req.requestId));
      return;
    }

    req.actor = result.actor;
    next();
  };
}
