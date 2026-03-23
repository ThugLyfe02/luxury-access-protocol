import { Router, Request, Response, NextFunction } from 'express';
import { AdminControlService } from '../../application/services/AdminControlService';
import { UserActor } from '../../application/auth/Actor';
import { AuthenticatedActor } from '../../auth/types/AuthenticatedActor';
import { FreezableEntityType } from '../../domain/entities/SystemFreeze';
import { successResponse, errorResponse } from '../dto/response';

export interface AdminRouteDeps {
  adminControlService: AdminControlService;
}

const VALID_FREEZE_ENTITY_TYPES = new Set(['USER', 'WATCH', 'RENTAL']);

export function createAdminRoutes(deps: AdminRouteDeps): Router {
  const router = Router();

  function actorFromReq(req: Request): UserActor {
    const auth = req.actor as AuthenticatedActor;
    return {
      kind: 'user',
      userId: auth.userId,
      role: auth.role,
    };
  }

  /**
   * POST /admin/freeze
   */
  router.post('/admin/freeze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromReq(req);
      const { entityType, entityId, reason } = req.body;

      if (!entityType || !entityId || !reason) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'entityType, entityId, and reason are required',
          req.requestId,
        ));
        return;
      }

      if (!VALID_FREEZE_ENTITY_TYPES.has(entityType)) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'entityType must be USER, WATCH, or RENTAL',
          req.requestId,
        ));
        return;
      }

      const freeze = await deps.adminControlService.freezeEntity(actor, {
        id: crypto.randomUUID(),
        entityType: entityType as FreezableEntityType,
        entityId,
        reason,
      });

      res.status(201).json(successResponse({
        freezeId: freeze.id,
        entityType: freeze.entityType,
        entityId: freeze.entityId,
        active: freeze.active,
      }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /admin/unfreeze
   */
  router.post('/admin/unfreeze', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromReq(req);
      const { freezeId } = req.body;

      if (!freezeId) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'freezeId is required',
          req.requestId,
        ));
        return;
      }

      await deps.adminControlService.unfreezeEntity(actor, { freezeId });

      res.status(200).json(successResponse({ unfrozen: true }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /admin/review/assign
   */
  router.post('/admin/review/assign', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromReq(req);
      const { reviewId, assigneeId } = req.body;

      if (!reviewId || !assigneeId) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'reviewId and assigneeId are required',
          req.requestId,
        ));
        return;
      }

      await deps.adminControlService.assignReview(actor, { reviewId, assigneeId });

      res.status(200).json(successResponse({ assigned: true }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /admin/review/approve
   */
  router.post('/admin/review/approve', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromReq(req);
      const { reviewId, resolution } = req.body;

      if (!reviewId || !resolution) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'reviewId and resolution are required',
          req.requestId,
        ));
        return;
      }

      await deps.adminControlService.approveReview(actor, { reviewId, resolution });

      res.status(200).json(successResponse({ approved: true }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /admin/review/reject
   */
  router.post('/admin/review/reject', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromReq(req);
      const { reviewId, resolution } = req.body;

      if (!reviewId || !resolution) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'reviewId and resolution are required',
          req.requestId,
        ));
        return;
      }

      await deps.adminControlService.rejectReview(actor, { reviewId, resolution });

      res.status(200).json(successResponse({ rejected: true }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /admin/review/note
   */
  router.post('/admin/review/note', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromReq(req);
      const { reviewId, note } = req.body;

      if (!reviewId || !note) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'reviewId and note are required',
          req.requestId,
        ));
        return;
      }

      await deps.adminControlService.addReviewNote(actor, { reviewId, note });

      res.status(200).json(successResponse({ noted: true }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
