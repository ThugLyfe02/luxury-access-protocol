import { Router, Request, Response, NextFunction } from 'express';
import { ReconciliationEngine } from '../../application/services/ReconciliationEngine';
import { RepairExecutor } from '../../application/services/RepairExecutor';
import { ReconciliationRepository, ReconciliationDiagnostics } from '../../domain/interfaces/ReconciliationRepository';
import { ReconciliationSeverity } from '../../domain/enums/ReconciliationSeverity';
import { ReconciliationFinding } from '../../domain/entities/ReconciliationFinding';
import { UserActor } from '../../application/auth/Actor';
import { AuthenticatedActor } from '../../auth/types/AuthenticatedActor';
import { successResponse, errorResponse } from '../dto/response';

export interface ReconciliationAdminRouteDeps {
  reconciliationEngine: ReconciliationEngine;
  repairExecutor: RepairExecutor;
  reconciliationRepo: ReconciliationRepository;
}

function serializeFinding(f: ReconciliationFinding) {
  return {
    id: f.id,
    runId: f.runId,
    aggregateType: f.aggregateType,
    aggregateId: f.aggregateId,
    providerObjectIds: f.providerObjectIds,
    driftType: f.driftType,
    severity: f.severity,
    recommendedAction: f.recommendedAction,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
    resolvedAt: f.resolvedAt?.toISOString() ?? null,
    resolvedBy: f.resolvedBy,
    repairAction: f.repairAction,
    internalSnapshot: f.internalSnapshot,
    providerSnapshot: f.providerSnapshot,
    metadata: f.metadata,
  };
}

export function createReconciliationAdminRoutes(deps: ReconciliationAdminRouteDeps): Router {
  const router = Router();

  function actorId(req: Request): string {
    const auth = req.actor as AuthenticatedActor;
    return auth.userId;
  }

  /** GET /admin/reconciliation/diagnostics */
  router.get('/admin/reconciliation/diagnostics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const diag = await deps.reconciliationRepo.diagnostics();
      res.status(200).json(successResponse(diag, req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/reconciliation/runs */
  router.get('/admin/reconciliation/runs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const runs = await deps.reconciliationRepo.listRuns(limit);
      res.status(200).json(successResponse(runs.map(r => ({
        id: r.id,
        triggeredBy: r.triggeredBy,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        summary: r.summary,
        error: r.error,
      })), req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/reconciliation/findings/unresolved */
  router.get('/admin/reconciliation/findings/unresolved', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const findings = await deps.reconciliationRepo.findUnresolved(limit);
      res.status(200).json(successResponse(findings.map(serializeFinding), req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/reconciliation/findings/severity/:severity */
  router.get('/admin/reconciliation/findings/severity/:severity', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const severity = req.params.severity as string as ReconciliationSeverity;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const findings = await deps.reconciliationRepo.findBySeverity(severity, limit);
      res.status(200).json(successResponse(findings.map(serializeFinding), req.requestId));
    } catch (error) { next(error); }
  });

  /** GET /admin/reconciliation/findings/:findingId */
  router.get('/admin/reconciliation/findings/:findingId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const finding = await deps.reconciliationRepo.findFindingById(req.params.findingId as string);
      if (!finding) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Finding not found', req.requestId));
        return;
      }
      res.status(200).json(successResponse(serializeFinding(finding), req.requestId));
    } catch (error) { next(error); }
  });

  /** POST /admin/reconciliation/reconcile/:rentalId — on-demand single rental */
  router.post('/admin/reconciliation/reconcile/:rentalId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deps.reconciliationEngine.reconcileById(
        req.params.rentalId as string,
        actorId(req),
      );
      res.status(200).json(successResponse(result, req.requestId));
    } catch (error) { next(error); }
  });

  /** POST /admin/reconciliation/findings/:findingId/repair — manual repair */
  router.post('/admin/reconciliation/findings/:findingId/repair', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { repairAction } = req.body;
      if (!repairAction) {
        res.status(400).json(errorResponse('VALIDATION_ERROR', 'repairAction is required', req.requestId));
        return;
      }

      const finding = await deps.reconciliationRepo.findFindingById(req.params.findingId as string);
      if (!finding) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Finding not found', req.requestId));
        return;
      }

      const result = await deps.repairExecutor.manualRepair(finding, actorId(req), repairAction);
      res.status(200).json(successResponse(result, req.requestId));
    } catch (error) { next(error); }
  });

  /** POST /admin/reconciliation/findings/:findingId/suppress */
  router.post('/admin/reconciliation/findings/:findingId/suppress', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        res.status(400).json(errorResponse('VALIDATION_ERROR', 'reason is required', req.requestId));
        return;
      }

      const finding = await deps.reconciliationRepo.findFindingById(req.params.findingId as string);
      if (!finding) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Finding not found', req.requestId));
        return;
      }

      await deps.repairExecutor.suppress(finding, actorId(req), reason);
      res.status(200).json(successResponse({ suppressed: true }, req.requestId));
    } catch (error) { next(error); }
  });

  /** POST /admin/reconciliation/findings/:findingId/acknowledge */
  router.post('/admin/reconciliation/findings/:findingId/acknowledge', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const finding = await deps.reconciliationRepo.findFindingById(req.params.findingId as string);
      if (!finding) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Finding not found', req.requestId));
        return;
      }

      finding.acknowledge(actorId(req), new Date());
      await deps.reconciliationRepo.saveFinding(finding);
      res.status(200).json(successResponse({ acknowledged: true }, req.requestId));
    } catch (error) { next(error); }
  });

  return router;
}
