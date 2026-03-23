import { Request, Response, NextFunction } from 'express';
import { MarketplaceRole } from '../../domain/enums/MarketplaceRole';
import { AuthenticatedActor } from '../../auth/types/AuthenticatedActor';
import { errorResponse } from '../dto/response';

/**
 * Middleware that enforces ADMIN role on authenticated requests.
 * Must be applied AFTER requireAuth.
 *
 * Fails closed: non-admin actors receive 403.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const actor = req.actor as AuthenticatedActor | undefined;

  if (!actor) {
    res.status(401).json(errorResponse(
      'UNAUTHORIZED',
      'Authentication required',
      req.requestId,
    ));
    return;
  }

  if (actor.role !== MarketplaceRole.ADMIN) {
    res.status(403).json(errorResponse(
      'UNAUTHORIZED_ADMIN_ACTION',
      'This action requires administrator privileges',
      req.requestId,
    ));
    return;
  }

  next();
}
