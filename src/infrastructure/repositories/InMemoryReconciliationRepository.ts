import { ReconciliationRun } from '../../domain/entities/ReconciliationRun';
import { ReconciliationFinding } from '../../domain/entities/ReconciliationFinding';
import { ReconciliationSeverity } from '../../domain/enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../../domain/enums/ReconciliationStatus';
import { DriftType } from '../../domain/enums/DriftType';
import { ReconciliationRepository, ReconciliationDiagnostics } from '../../domain/interfaces/ReconciliationRepository';

const SEVERITY_ORDER: Record<string, number> = {
  [ReconciliationSeverity.CRITICAL]: 0,
  [ReconciliationSeverity.HIGH]: 1,
  [ReconciliationSeverity.MEDIUM]: 2,
  [ReconciliationSeverity.LOW]: 3,
  [ReconciliationSeverity.INFO]: 4,
};

export class InMemoryReconciliationRepository implements ReconciliationRepository {
  private readonly runs: Map<string, ReconciliationRun> = new Map();
  private readonly findings: Map<string, ReconciliationFinding> = new Map();

  async createRun(run: ReconciliationRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async saveRun(run: ReconciliationRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async findRunById(id: string): Promise<ReconciliationRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(limit: number): Promise<ReconciliationRun[]> {
    return Array.from(this.runs.values())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async createFinding(finding: ReconciliationFinding): Promise<void> {
    this.findings.set(finding.id, finding);
  }

  async saveFinding(finding: ReconciliationFinding): Promise<void> {
    this.findings.set(finding.id, finding);
  }

  async findFindingById(id: string): Promise<ReconciliationFinding | null> {
    return this.findings.get(id) ?? null;
  }

  async findUnresolved(limit: number): Promise<ReconciliationFinding[]> {
    return Array.from(this.findings.values())
      .filter(f => !f.isResolved())
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
      .slice(0, limit);
  }

  async findBySeverity(severity: ReconciliationSeverity, limit: number): Promise<ReconciliationFinding[]> {
    return Array.from(this.findings.values())
      .filter(f => f.severity === severity)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async findByAggregate(aggregateType: string, aggregateId: string): Promise<ReconciliationFinding[]> {
    return Array.from(this.findings.values())
      .filter(f => f.aggregateType === aggregateType && f.aggregateId === aggregateId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findByProviderObjectId(providerObjectId: string): Promise<ReconciliationFinding[]> {
    return Array.from(this.findings.values())
      .filter(f => f.providerObjectIds.includes(providerObjectId));
  }

  async findByRunId(runId: string): Promise<ReconciliationFinding[]> {
    return Array.from(this.findings.values())
      .filter(f => f.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findOpenByAggregateAndDrift(aggregateType: string, aggregateId: string, driftType: DriftType): Promise<ReconciliationFinding | null> {
    for (const f of this.findings.values()) {
      if (
        f.aggregateType === aggregateType &&
        f.aggregateId === aggregateId &&
        f.driftType === driftType &&
        !f.isResolved()
      ) {
        return f;
      }
    }
    return null;
  }

  async diagnostics(): Promise<ReconciliationDiagnostics> {
    let unresolvedCount = 0;
    const countBySeverity: Record<string, number> = {};
    const countByDriftType: Record<string, number> = {};
    let repairSuccessCount = 0;
    let oldestUnresolved: Date | null = null;
    let lastSuccessfulRun: Date | null = null;
    let lastFailedRun: Date | null = null;

    for (const f of this.findings.values()) {
      if (!f.isResolved()) {
        unresolvedCount++;
        if (!oldestUnresolved || f.createdAt < oldestUnresolved) {
          oldestUnresolved = f.createdAt;
        }
      }
      countBySeverity[f.severity] = (countBySeverity[f.severity] ?? 0) + 1;
      countByDriftType[f.driftType] = (countByDriftType[f.driftType] ?? 0) + 1;
      if (f.status === ReconciliationStatus.REPAIRED) repairSuccessCount++;
    }

    for (const r of this.runs.values()) {
      if (r.status === 'COMPLETED') {
        if (!lastSuccessfulRun || (r.completedAt && r.completedAt > lastSuccessfulRun)) {
          lastSuccessfulRun = r.completedAt;
        }
      }
      if (r.status === 'FAILED') {
        if (!lastFailedRun || (r.completedAt && r.completedAt > lastFailedRun)) {
          lastFailedRun = r.completedAt;
        }
      }
    }

    return {
      unresolvedCount,
      countBySeverity,
      countByDriftType,
      lastSuccessfulRun,
      lastFailedRun,
      repairSuccessCount,
      oldestUnresolvedFinding: oldestUnresolved,
    };
  }
}
