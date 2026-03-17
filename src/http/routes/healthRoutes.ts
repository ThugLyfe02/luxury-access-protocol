import { Router, Request, Response } from 'express';
import { successResponse } from '../dto/response';

export interface HealthDeps {
  persistence: 'postgres' | 'memory';
  stripe: 'live' | 'stub';
}

export function createHealthRoutes(deps: HealthDeps): Router {
  const router = Router();

  /**
   * GET /health
   * Basic uptime check. Always 200 if the process is running.
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
   * Readiness probe. Confirms critical config and dependencies are available.
   * Returns 503 if essential services are not configured.
   */
  router.get('/ready', (_req: Request, res: Response) => {
    const checks: Record<string, boolean> = {
      persistence: true, // always ready — either in-memory or postgres
      stripe: deps.stripe === 'live',
    };

    const allReady = Object.values(checks).every(Boolean);

    res.status(allReady ? 200 : 503).json(successResponse({
      ready: allReady,
      checks,
    }, _req.requestId));
  });

  return router;
}
