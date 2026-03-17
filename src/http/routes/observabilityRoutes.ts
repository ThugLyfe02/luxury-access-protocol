import { Router, Request, Response, NextFunction } from 'express';
import { successResponse } from '../dto/response';
import { MetricsRegistry } from '../../observability/metrics/MetricsRegistry';
import { SystemDiagnosticsService } from '../../observability/diagnostics/SystemDiagnosticsService';
import { IncidentSnapshotBuilder } from '../../observability/diagnostics/IncidentSnapshotBuilder';
import { SLOEvaluator } from '../../observability/slos/SLOEvaluator';

export interface ObservabilityRouteDeps {
  registry: MetricsRegistry;
  diagnosticsService: SystemDiagnosticsService;
  incidentSnapshotBuilder: IncidentSnapshotBuilder;
  sloEvaluator: SLOEvaluator;
}

export function createObservabilityRoutes(deps: ObservabilityRouteDeps): Router {
  const router = Router();

  /** GET /admin/metrics — all metric snapshots */
  router.get('/admin/metrics', (req: Request, res: Response) => {
    const snapshot = deps.registry.getSnapshot();
    res.status(200).json(successResponse(snapshot, req.requestId));
  });

  /** GET /admin/diagnostics — full system diagnostics */
  router.get('/admin/diagnostics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshot = await deps.diagnosticsService.getSystemSnapshot();
      res.status(200).json(successResponse(snapshot, req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/incidents/:id — incident snapshot for a rental */
  router.get('/admin/incidents/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rentalId = req.params.id as string;
      const snapshot = await deps.incidentSnapshotBuilder.buildForRental(rentalId);
      res.status(200).json(successResponse(snapshot, req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/slos — SLO evaluation results */
  router.get('/admin/slos', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const results = await deps.sloEvaluator.evaluate();
      const overallStatus = results.some(r => r.status === 'critical') ? 'critical'
        : results.some(r => r.status === 'degraded') ? 'degraded' : 'healthy';
      res.status(200).json(successResponse({
        overallStatus,
        slos: results,
        evaluatedAt: new Date().toISOString(),
      }, req.requestId));
    } catch (error) { next(error); }
  });

  return router;
}
