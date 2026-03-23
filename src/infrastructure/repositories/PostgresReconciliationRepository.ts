import { ReconciliationRun, RunStatus } from '../../domain/entities/ReconciliationRun';
import { ReconciliationFinding } from '../../domain/entities/ReconciliationFinding';
import { ReconciliationSeverity } from '../../domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../domain/enums/ReconciliationStatus';
import { DriftType } from '../../domain/enums/DriftType';
import { RecommendedAction } from '../../domain/services/DriftTaxonomy';
import { ReconciliationRepository, ReconciliationDiagnostics } from '../../domain/interfaces/ReconciliationRepository';
import { PostgresClient } from '../db/PostgresClient';

function rowToRun(row: Record<string, unknown>): ReconciliationRun {
  return ReconciliationRun.restore({
    id: row.id as string,
    triggeredBy: row.triggered_by as string,
    status: row.status as RunStatus,
    startedAt: new Date(row.started_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    totalChecked: row.total_checked as number,
    totalFindings: row.total_findings as number,
    findingsBySeverity: (row.findings_by_severity as Record<string, number>) ?? {},
    repairedCount: row.repaired_count as number,
    escalatedCount: row.escalated_count as number,
    failedChecks: row.failed_checks as number,
    error: row.error as string | null,
  });
}

function rowToFinding(row: Record<string, unknown>): ReconciliationFinding {
  return ReconciliationFinding.restore({
    id: row.id as string,
    runId: row.run_id as string,
    aggregateType: row.aggregate_type as string,
    aggregateId: row.aggregate_id as string,
    providerObjectIds: (row.provider_object_ids as string[]) ?? [],
    internalSnapshot: (row.internal_snapshot as Record<string, unknown>) ?? {},
    providerSnapshot: (row.provider_snapshot as Record<string, unknown>) ?? {},
    driftType: row.drift_type as DriftType,
    severity: row.severity as ReconciliationSeverity,
    recommendedAction: row.recommended_action as RecommendedAction,
    status: row.status as ReconciliationStatus,
    createdAt: new Date(row.created_at as string),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    resolvedBy: row.resolved_by as string | null,
    repairAction: row.repair_action as string | null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  });
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  private readonly db: PostgresClient;

  constructor() {
    this.db = new PostgresClient();
  }

  async createRun(run: ReconciliationRun): Promise<void> {
    const s = run.summary;
    await this.db.query(
      `INSERT INTO reconciliation_runs (
        id, triggered_by, status, started_at, completed_at,
        total_checked, total_findings, findings_by_severity,
        repaired_count, escalated_count, failed_checks, error
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [run.id, run.triggeredBy, run.status, run.startedAt, run.completedAt,
       s.totalChecked, s.totalFindings, JSON.stringify(s.findingsBySeverity),
       s.repairedCount, s.escalatedCount, s.failedChecks, run.error],
    );
  }

  async saveRun(run: ReconciliationRun): Promise<void> {
    const s = run.summary;
    await this.db.query(
      `UPDATE reconciliation_runs SET
        status=$2, completed_at=$3, total_checked=$4, total_findings=$5,
        findings_by_severity=$6, repaired_count=$7, escalated_count=$8,
        failed_checks=$9, error=$10
       WHERE id=$1`,
      [run.id, run.status, run.completedAt, s.totalChecked, s.totalFindings,
       JSON.stringify(s.findingsBySeverity), s.repairedCount, s.escalatedCount,
       s.failedChecks, run.error],
    );
  }

  async findRunById(id: string): Promise<ReconciliationRun | null> {
    const { rows } = await this.db.query(`SELECT * FROM reconciliation_runs WHERE id=$1`, [id]);
    return rows.length ? rowToRun(rows[0]) : null;
  }

  async listRuns(limit: number): Promise<ReconciliationRun[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT $1`, [limit],
    );
    return rows.map(rowToRun);
  }

  async createFinding(finding: ReconciliationFinding): Promise<void> {
    await this.db.query(
      `INSERT INTO reconciliation_findings (
        id, run_id, aggregate_type, aggregate_id, provider_object_ids,
        internal_snapshot, provider_snapshot, drift_type, severity,
        recommended_action, status, created_at, resolved_at, resolved_by,
        repair_action, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [finding.id, finding.runId, finding.aggregateType, finding.aggregateId,
       JSON.stringify(finding.providerObjectIds), JSON.stringify(finding.internalSnapshot),
       JSON.stringify(finding.providerSnapshot), finding.driftType, finding.severity,
       finding.recommendedAction, finding.status, finding.createdAt, finding.resolvedAt,
       finding.resolvedBy, finding.repairAction, JSON.stringify(finding.metadata)],
    );
  }

  async saveFinding(finding: ReconciliationFinding): Promise<void> {
    await this.db.query(
      `UPDATE reconciliation_findings SET
        status=$2, resolved_at=$3, resolved_by=$4, repair_action=$5, metadata=$6
       WHERE id=$1`,
      [finding.id, finding.status, finding.resolvedAt, finding.resolvedBy,
       finding.repairAction, JSON.stringify(finding.metadata)],
    );
  }

  async findFindingById(id: string): Promise<ReconciliationFinding | null> {
    const { rows } = await this.db.query(`SELECT * FROM reconciliation_findings WHERE id=$1`, [id]);
    return rows.length ? rowToFinding(rows[0]) : null;
  }

  async findUnresolved(limit: number): Promise<ReconciliationFinding[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_findings
       WHERE status NOT IN ('REPAIRED','SUPPRESSED')
       ORDER BY CASE severity
         WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
         WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END,
         created_at ASC
       LIMIT $1`, [limit],
    );
    return rows.map(rowToFinding);
  }

  async findBySeverity(severity: ReconciliationSeverity, limit: number): Promise<ReconciliationFinding[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_findings WHERE severity=$1 ORDER BY created_at ASC LIMIT $2`,
      [severity, limit],
    );
    return rows.map(rowToFinding);
  }

  async findByAggregate(aggregateType: string, aggregateId: string): Promise<ReconciliationFinding[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_findings WHERE aggregate_type=$1 AND aggregate_id=$2 ORDER BY created_at ASC`,
      [aggregateType, aggregateId],
    );
    return rows.map(rowToFinding);
  }

  async findByProviderObjectId(providerObjectId: string): Promise<ReconciliationFinding[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_findings WHERE provider_object_ids @> $1::jsonb`,
      [JSON.stringify([providerObjectId])],
    );
    return rows.map(rowToFinding);
  }

  async findByRunId(runId: string): Promise<ReconciliationFinding[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_findings WHERE run_id=$1 ORDER BY created_at ASC`, [runId],
    );
    return rows.map(rowToFinding);
  }

  async findOpenByAggregateAndDrift(aggregateType: string, aggregateId: string, driftType: DriftType): Promise<ReconciliationFinding | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM reconciliation_findings
       WHERE aggregate_type=$1 AND aggregate_id=$2 AND drift_type=$3
       AND status NOT IN ('REPAIRED','SUPPRESSED')
       LIMIT 1`,
      [aggregateType, aggregateId, driftType],
    );
    return rows.length ? rowToFinding(rows[0]) : null;
  }

  async diagnostics(): Promise<ReconciliationDiagnostics> {
    const [unresolvedRes, severityRes, driftRes, runsRes, repairRes, oldestRes] = await Promise.all([
      this.db.query(`SELECT COUNT(*)::int AS c FROM reconciliation_findings WHERE status NOT IN ('REPAIRED','SUPPRESSED')`),
      this.db.query(`SELECT severity, COUNT(*)::int AS c FROM reconciliation_findings GROUP BY severity`),
      this.db.query(`SELECT drift_type, COUNT(*)::int AS c FROM reconciliation_findings GROUP BY drift_type`),
      this.db.query(`SELECT status, MAX(completed_at) AS last FROM reconciliation_runs WHERE status IN ('COMPLETED','FAILED') GROUP BY status`),
      this.db.query(`SELECT COUNT(*)::int AS c FROM reconciliation_findings WHERE status='REPAIRED'`),
      this.db.query(`SELECT MIN(created_at) AS oldest FROM reconciliation_findings WHERE status NOT IN ('REPAIRED','SUPPRESSED')`),
    ]);

    const countBySeverity: Record<string, number> = {};
    for (const r of severityRes.rows) countBySeverity[r.severity as string] = r.c as number;

    const countByDriftType: Record<string, number> = {};
    for (const r of driftRes.rows) countByDriftType[r.drift_type as string] = r.c as number;

    let lastSuccessfulRun: Date | null = null;
    let lastFailedRun: Date | null = null;
    for (const r of runsRes.rows) {
      if (r.status === 'COMPLETED' && r.last) lastSuccessfulRun = new Date(r.last as string);
      if (r.status === 'FAILED' && r.last) lastFailedRun = new Date(r.last as string);
    }

    return {
      unresolvedCount: unresolvedRes.rows[0]?.c ?? 0,
      countBySeverity,
      countByDriftType,
      lastSuccessfulRun,
      lastFailedRun,
      repairSuccessCount: repairRes.rows[0]?.c ?? 0,
      oldestUnresolvedFinding: oldestRes.rows[0]?.oldest ? new Date(oldestRes.rows[0].oldest as string) : null,
    };
  }
}
