import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../../http/dto/response';
import crypto from 'node:crypto';

/**
 * Internal access middleware factory.
 * Protects internal/admin diagnostic routes.
 *
 * Accepts two modes:
 * 1. Internal API token via X-Internal-Token header
 * 2. Admin JWT already verified by requireAuth (actor.role === 'ADMIN')
 *
 * Fails closed: missing/invalid credentials → 403.
 */
export function requireInternalAccess(internalApiToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Mode 1: Internal API token header
    const providedToken = req.headers['x-internal-token'];
    if (typeof providedToken === 'string' && providedToken.length > 0) {
      // Constant-time comparison to prevent timing attacks
      const expected = Buffer.from(internalApiToken, 'utf-8');
      const received = Buffer.from(providedToken, 'utf-8');

      if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) {
        next();
        return;
      }

      res.status(403).json(errorResponse(
        'FORBIDDEN',
        'Invalid internal access token',
        req.requestId,
      ));
      return;
    }

    // Mode 2: Admin role from verified JWT
    if (req.actor && req.actor.role === 'ADMIN') {
      next();
      return;
    }

    res.status(403).json(errorResponse(
      'FORBIDDEN',
      'Internal access required',
      req.requestId,
    ));
  };
}
