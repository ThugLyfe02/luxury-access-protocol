import { Router, Request, Response, NextFunction } from 'express';
import { OutboxTransferDiagnosticsService } from '../../application/services/OutboxTransferDiagnosticsService';
import { successResponse, errorResponse } from '../dto/response';

export interface TransferDiagnosticsRouteDeps {
  outboxTransferDiagnosticsService: OutboxTransferDiagnosticsService;
}

/**
 * Read-only admin routes for stuck transfer-truth diagnostics.
 * NO mutations. NO retries triggered.
 */
export function createTransferDiagnosticsRoutes(deps: TransferDiagnosticsRouteDeps): Router {
  const router = Router();

  /**
   * GET /admin/transfers/stuck
   * Summary + correlations of all stuck transfer-truth rentals.
   */
  router.get('/admin/transfers/stuck', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const thresholdMs = parseInt(req.query.thresholdMs as string) || 300_000;
      const [summary, correlations] = await Promise.all([
        deps.outboxTransferDiagnosticsService.getStuckTransferSummary(thresholdMs),
        deps.outboxTransferDiagnosticsService.getStuckTransferCorrelations(thresholdMs),
      ]);
      res.status(200).json(successResponse({ summary, correlations }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /admin/transfers/stuck/:rentalId
   * Detailed diagnostics for a single rental.
   */
  router.get('/admin/transfers/stuck/:rentalId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const detail = await deps.outboxTransferDiagnosticsService.getStuckTransferDetails(
        req.params.rentalId as string,
      );
      if (!detail) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Rental not found', req.requestId));
        return;
      }
      res.status(200).json(successResponse(detail, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
