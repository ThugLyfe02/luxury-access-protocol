import { Router, Request, Response } from 'express';
import { successResponse } from '../dto/response';
import { HealthMonitor } from '../../infrastructure/resilience/HealthMonitor';

export interface HealthDeps {
  persistence: 'postgres' | 'memory';
  stripe: 'live' | 'stub';
  healthMonitor?: HealthMonitor;
}

export function createHealthRoutes(deps: HealthDeps): Router {
  const router = Router();

  /**
   * GET /health
   * Liveness probe. Always 200 if the process is running.
   * Does NOT evaluate dependency health.
   */
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json(successResponse({
      status: 'ok',
      persistence: deps.persistence,
      stripe: deps.stripe,
    }, _req.requestId));
  });

  /**
   * GET /ready
   * Readiness probe. Evaluates real dependency health.
   * Returns 503 if system cannot safely serve critical traffic.
   * Returns 200 with degraded reasons if partially impaired.
   */
  router.get('/ready', async (_req: Request, res: Response) => {
    if (!deps.healthMonitor) {
      // Fallback: legacy behavior when no health monitor configured
      const checks: Record<string, boolean> = {
        persistence: true,
        stripe: deps.stripe === 'live',
      };
      const allReady = Object.values(checks).every(Boolean);
      res.status(allReady ? 200 : 503).json(successResponse({
        ready: allReady,
        checks,
      }, _req.requestId));
      return;
    }

    const report = await deps.healthMonitor.getReport();
    const statusCode = report.status === 'NOT_READY' ? 503 : 200;

    res.status(statusCode).json(successResponse({
      ready: report.status !== 'NOT_READY',
      status: report.status,
      checks: report.checks.reduce((acc, c) => {
        acc[c.name] = { healthy: c.healthy, message: c.message };
        return acc;
      }, {} as Record<string, { healthy: boolean; message?: string }>),
      degradedReasons: report.degradedReasons,
      workers: report.workers.map(w => ({
        name: w.name,
        running: w.running,
        lastHeartbeat: w.lastHeartbeat?.toISOString() ?? null,
      })),
    }, _req.requestId));
  });

  return router;
}
