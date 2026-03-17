import { ReconciliationRun } from '../entities/ReconciliationRun';
import { ReconciliationFinding } from '../entities/ReconciliationFinding';
import { ReconciliationSeverity } from '../enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../enums/ReconciliationStatus';
import { DriftType } from '../enums/DriftType';

export interface ReconciliationDiagnostics {
  readonly unresolvedCount: number;
  readonly countBySeverity: Readonly<Record<string, number>>;
  readonly countByDriftType: Readonly<Record<string, number>>;
  readonly lastSuccessfulRun: Date | null;
  readonly lastFailedRun: Date | null;
  readonly repairSuccessCount: number;
  readonly oldestUnresolvedFinding: Date | null;
}

export interface ReconciliationRepository {
  // --- Runs ---
  createRun(run: ReconciliationRun): Promise<void>;
  saveRun(run: ReconciliationRun): Promise<void>;
  findRunById(id: string): Promise<ReconciliationRun | null>;
  listRuns(limit: number): Promise<ReconciliationRun[]>;

  // --- Findings ---
  createFinding(finding: ReconciliationFinding): Promise<void>;
  saveFinding(finding: ReconciliationFinding): Promise<void>;
  findFindingById(id: string): Promise<ReconciliationFinding | null>;

  /** Find unresolved findings, ordered by severity (CRITICAL first) */
  findUnresolved(limit: number): Promise<ReconciliationFinding[]>;

  /** Find findings by severity */
  findBySeverity(severity: ReconciliationSeverity, limit: number): Promise<ReconciliationFinding[]>;

  /** Find findings for a specific aggregate */
  findByAggregate(aggregateType: string, aggregateId: string): Promise<ReconciliationFinding[]>;

  /** Find findings by provider object ID */
  findByProviderObjectId(providerObjectId: string): Promise<ReconciliationFinding[]>;

  /** Find findings for a specific run */
  findByRunId(runId: string): Promise<ReconciliationFinding[]>;

  /** Check if an open finding already exists for this aggregate + drift type (dedup) */
  findOpenByAggregateAndDrift(aggregateType: string, aggregateId: string, driftType: DriftType): Promise<ReconciliationFinding | null>;

  // --- Diagnostics ---
  diagnostics(): Promise<ReconciliationDiagnostics>;
}
