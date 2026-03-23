import { Router, Request, Response, NextFunction } from 'express';
import { successResponse } from '../dto/response';
import { HealthMonitor } from '../../infrastructure/resilience/HealthMonitor';
import { CircuitBreaker } from '../../infrastructure/resilience/CircuitBreaker';
import { ResilienceConfig } from '../../infrastructure/resilience/ResilienceConfig';
import { WorkerRegistry } from '../../infrastructure/coordination/WorkerRegistry';
import { DistributedLeaseManager } from '../../infrastructure/coordination/DistributedLeaseManager';

export interface ResilienceAdminRouteDeps {
  healthMonitor: HealthMonitor;
  breakers: CircuitBreaker[];
  resilienceConfig: ResilienceConfig;
  workerRegistry?: WorkerRegistry;
  leaseManager?: DistributedLeaseManager;
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

  /** GET /admin/resilience/workers — cluster worker registry */
  router.get('/admin/resilience/workers', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.workerRegistry) {
        res.status(200).json(successResponse({ workers: [], message: 'Worker registry not configured' }, req.requestId));
        return;
      }
      const workers = await deps.workerRegistry.getAll();
      res.status(200).json(successResponse({ workers }, req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/resilience/leases — active distributed leases */
  router.get('/admin/resilience/leases', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.leaseManager) {
        res.status(200).json(successResponse({ leases: [], message: 'Lease manager not configured' }, req.requestId));
        return;
      }
      const leases = await deps.leaseManager.getAll();
      res.status(200).json(successResponse({ leases }, req.requestId));
    } catch (error) { next(error); }
  });

  return router;
}
