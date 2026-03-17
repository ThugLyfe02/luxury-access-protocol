import { Router, Request, Response, NextFunction } from 'express';
import { successResponse } from '../dto/response';
import { HealthMonitor } from '../../infrastructure/resilience/HealthMonitor';
import { CircuitBreaker } from '../../infrastructure/resilience/CircuitBreaker';
import { ResilienceConfig } from '../../infrastructure/resilience/ResilienceConfig';

export interface ResilienceAdminRouteDeps {
  healthMonitor: HealthMonitor;
  breakers: CircuitBreaker[];
  resilienceConfig: ResilienceConfig;
}

export function createResilienceAdminRoutes(deps: ResilienceAdminRouteDeps): Router {
  const router = Router();

  /** GET /admin/resilience/health — full health report */
  router.get('/admin/resilience/health', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await deps.healthMonitor.getReport();
      res.status(200).json(successResponse({
        status: report.status,
        checks: report.checks,
        degradedReasons: report.degradedReasons,
        workers: report.workers,
        breakers: report.breakers,
        timestamp: report.timestamp.toISOString(),
      }, req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/resilience/breakers — circuit breaker states */
  router.get('/admin/resilience/breakers', (req: Request, res: Response) => {
    const diagnostics = deps.breakers.map(b => b.diagnostics());
    res.status(200).json(successResponse(diagnostics, req.requestId));
  });

  /** GET /admin/resilience/config — safe subset of resilience config */
  router.get('/admin/resilience/config', (req: Request, res: Response) => {
    const c = deps.resilienceConfig;
    res.status(200).json(successResponse({
      timeouts: {
        providerCallMs: c.providerCallTimeoutMs,
        providerSnapshotMs: c.providerSnapshotTimeoutMs,
        dbQueryMs: c.dbQueryTimeoutMs,
        outboxHandlerMs: c.outboxHandlerTimeoutMs,
      },
      circuitBreaker: {
        failureThreshold: c.breakerFailureThreshold,
        resetTimeoutMs: c.breakerResetTimeoutMs,
        halfOpenMaxProbes: c.breakerHalfOpenMaxProbes,
      },
      concurrency: {
        outboxWorkerConcurrency: c.outboxWorkerConcurrency,
        outboxWorkerBatchSize: c.outboxWorkerBatchSize,
        reconciliationWorkerBatchSize: c.reconciliationWorkerBatchSize,
      },
      rateLimits: {
        windowMs: c.rateLimitWindowMs,
        rentalInitiation: c.rateLimitRentalInitiation,
        ownerOnboarding: c.rateLimitOwnerOnboarding,
        adminRepair: c.rateLimitAdminRepair,
      },
      healthThresholds: {
        outboxBacklogDegraded: c.outboxBacklogDegradedThreshold,
        outboxBacklogNotReady: c.outboxBacklogNotReadyThreshold,
        reconUnresolvedCritical: c.reconUnresolvedCriticalThreshold,
        workerHeartbeatStaleMs: c.workerHeartbeatStaleMs,
      },
    }, req.requestId));
  });

  return router;
}
