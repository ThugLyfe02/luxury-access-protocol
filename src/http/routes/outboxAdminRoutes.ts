import { Router, Request, Response, NextFunction } from 'express';
import { OutboxDiagnosticsService } from '../../application/services/OutboxDiagnosticsService';
import { OutboxEventTopic, OutboxEventStatus } from '../../domain/entities/OutboxEvent';
import { successResponse, errorResponse } from '../dto/response';

export interface OutboxAdminRouteDeps {
  outboxDiagnosticsService: OutboxDiagnosticsService;
}

const VALID_STATUSES = new Set(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER']);

function serializeEvent(event: import('../../domain/entities/OutboxEvent').OutboxEvent) {
  return {
    id: event.id,
    topic: event.topic,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    dedupKey: event.dedupKey,
    status: event.status,
    attemptCount: event.attemptCount,
    maxAttempts: event.maxAttempts,
    availableAt: event.availableAt.toISOString(),
    lockedAt: event.lockedAt?.toISOString() ?? null,
    lockedBy: event.lockedBy,
    lastError: event.lastError,
    result: event.result,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

export function createOutboxAdminRoutes(deps: OutboxAdminRouteDeps): Router {
  const router = Router();

  /**
   * GET /admin/outbox/status
   * Dashboard: counts by status.
   */
  router.get('/admin/outbox/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await deps.outboxDiagnosticsService.getStatus();
      res.status(200).json(successResponse(status, _req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /admin/outbox/dead-letters
   * List dead-lettered events.
   */
  router.get('/admin/outbox/dead-letters', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const events = await deps.outboxDiagnosticsService.listDeadLetters(limit);
      res.status(200).json(successResponse(events.map(serializeEvent), req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /admin/outbox/dead-letters/:eventId/retry
   * Retry a dead-lettered event.
   */
  router.post('/admin/outbox/dead-letters/:eventId/retry', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await deps.outboxDiagnosticsService.retryDeadLetter(req.params.eventId as string);
      if (!event) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Outbox event not found', req.requestId));
        return;
      }
      res.status(200).json(successResponse(serializeEvent(event), req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /admin/outbox/events/:eventId
   * Look up a single event by ID.
   */
  router.get('/admin/outbox/events/:eventId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await deps.outboxDiagnosticsService.findEvent(req.params.eventId as string);
      if (!event) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Outbox event not found', req.requestId));
        return;
      }
      res.status(200).json(successResponse(serializeEvent(event), req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /admin/outbox/aggregates/:aggregateType/:aggregateId
   * List all outbox events for a given aggregate.
   */
  router.get('/admin/outbox/aggregates/:aggregateType/:aggregateId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const events = await deps.outboxDiagnosticsService.findByAggregate(
        req.params.aggregateType as string,
        req.params.aggregateId as string,
      );
      res.status(200).json(successResponse(events.map(serializeEvent), req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /admin/outbox/topics/:topic?status=PENDING&limit=50
   * List events by topic and status.
   */
  router.get('/admin/outbox/topics/:topic', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = (req.query.status as string) || 'PENDING';
      if (!VALID_STATUSES.has(status)) {
        res.status(400).json(errorResponse('VALIDATION_ERROR', 'Invalid status', req.requestId));
        return;
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const events = await deps.outboxDiagnosticsService.findByTopicAndStatus(
        req.params.topic as OutboxEventTopic,
        status as OutboxEventStatus,
        limit,
      );
      res.status(200).json(successResponse(events.map(serializeEvent), req.requestId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
