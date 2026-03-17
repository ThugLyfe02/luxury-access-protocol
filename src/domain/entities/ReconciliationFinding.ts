import { DomainError } from '../errors/DomainError';
import { DriftType } from '../enums/DriftType';
import { ReconciliationSeverity } from '../enums/ReconciliationSeverity';
import { ReconciliationStatus } from '../enums/ReconciliationStatus';
import { RecommendedAction } from '../services/DriftTaxonomy';

const VALID_TRANSITIONS: ReadonlyMap<ReconciliationStatus, ReadonlySet<ReconciliationStatus>> =
  new Map([
    [ReconciliationStatus.OPEN, new Set([
      ReconciliationStatus.ACKNOWLEDGED,
      ReconciliationStatus.REPAIRED,
      ReconciliationStatus.SUPPRESSED,
      ReconciliationStatus.ESCALATED,
    ])],
    [ReconciliationStatus.ACKNOWLEDGED, new Set([
      ReconciliationStatus.REPAIRED,
      ReconciliationStatus.ESCALATED,
    ])],
    [ReconciliationStatus.ESCALATED, new Set([
      ReconciliationStatus.REPAIRED,
      ReconciliationStatus.SUPPRESSED,
    ])],
    [ReconciliationStatus.REPAIRED, new Set<ReconciliationStatus>()],
    [ReconciliationStatus.SUPPRESSED, new Set<ReconciliationStatus>()],
  ]);

export class ReconciliationFinding {
  readonly id: string;
  readonly runId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly providerObjectIds: ReadonlyArray<string>;
  readonly internalSnapshot: Readonly<Record<string, unknown>>;
  readonly providerSnapshot: Readonly<Record<string, unknown>>;
  readonly driftType: DriftType;
  readonly severity: ReconciliationSeverity;
  readonly recommendedAction: RecommendedAction;
  readonly createdAt: Date;
  private _status: ReconciliationStatus;
  private _resolvedAt: Date | null;
  private _resolvedBy: string | null;
  private _repairAction: string | null;
  private _metadata: Readonly<Record<string, unknown>>;

  private constructor(params: {
    id: string;
    runId: string;
    aggregateType: string;
    aggregateId: string;
    providerObjectIds: string[];
    internalSnapshot: Record<string, unknown>;
    providerSnapshot: Record<string, unknown>;
    driftType: DriftType;
    severity: ReconciliationSeverity;
    recommendedAction: RecommendedAction;
    status: ReconciliationStatus;
    createdAt: Date;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    repairAction: string | null;
    metadata: Record<string, unknown>;
  }) {
    this.id = params.id;
    this.runId = params.runId;
    this.aggregateType = params.aggregateType;
    this.aggregateId = params.aggregateId;
    this.providerObjectIds = Object.freeze([...params.providerObjectIds]);
    this.internalSnapshot = Object.freeze({ ...params.internalSnapshot });
    this.providerSnapshot = Object.freeze({ ...params.providerSnapshot });
    this.driftType = params.driftType;
    this.severity = params.severity;
    this.recommendedAction = params.recommendedAction;
    this._status = params.status;
    this.createdAt = params.createdAt;
    this._resolvedAt = params.resolvedAt;
    this._resolvedBy = params.resolvedBy;
    this._repairAction = params.repairAction;
    this._metadata = Object.freeze({ ...params.metadata });
  }

  static create(params: {
    id: string;
    runId: string;
    aggregateType: string;
    aggregateId: string;
    providerObjectIds: string[];
    internalSnapshot: Record<string, unknown>;
    providerSnapshot: Record<string, unknown>;
    driftType: DriftType;
    severity: ReconciliationSeverity;
    recommendedAction: RecommendedAction;
    createdAt: Date;
    metadata?: Record<string, unknown>;
  }): ReconciliationFinding {
    if (!params.id) throw new DomainError('Finding ID is required', 'INVALID_STATE_TRANSITION');
    if (!params.runId) throw new DomainError('Run ID is required', 'INVALID_STATE_TRANSITION');
    if (!params.aggregateId) throw new DomainError('Aggregate ID is required', 'INVALID_STATE_TRANSITION');

    return new ReconciliationFinding({
      ...params,
      status: ReconciliationStatus.OPEN,
      resolvedAt: null,
      resolvedBy: null,
      repairAction: null,
      metadata: params.metadata ?? {},
    });
  }

  static restore(params: {
    id: string;
    runId: string;
    aggregateType: string;
    aggregateId: string;
    providerObjectIds: string[];
    internalSnapshot: Record<string, unknown>;
    providerSnapshot: Record<string, unknown>;
    driftType: DriftType;
    severity: ReconciliationSeverity;
    recommendedAction: RecommendedAction;
    status: ReconciliationStatus;
    createdAt: Date;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    repairAction: string | null;
    metadata: Record<string, unknown>;
  }): ReconciliationFinding {
    return new ReconciliationFinding(params);
  }

  get status(): ReconciliationStatus { return this._status; }
  get resolvedAt(): Date | null { return this._resolvedAt; }
  get resolvedBy(): string | null { return this._resolvedBy; }
  get repairAction(): string | null { return this._repairAction; }
  get metadata(): Readonly<Record<string, unknown>> { return this._metadata; }

  isResolved(): boolean {
    return this._status === ReconciliationStatus.REPAIRED ||
           this._status === ReconciliationStatus.SUPPRESSED;
  }

  acknowledge(actorId: string, now: Date): void {
    this.transitionTo(ReconciliationStatus.ACKNOWLEDGED);
    this._resolvedBy = actorId;
    this._metadata = Object.freeze({ ...this._metadata, acknowledgedBy: actorId, acknowledgedAt: now.toISOString() });
  }

  markRepaired(actorId: string, repairAction: string, now: Date): void {
    if (!repairAction) throw new DomainError('Repair action description is required', 'INVALID_STATE_TRANSITION');
    this.transitionTo(ReconciliationStatus.REPAIRED);
    this._resolvedAt = now;
    this._resolvedBy = actorId;
    this._repairAction = repairAction;
  }

  suppress(actorId: string, reason: string, now: Date): void {
    if (!reason) throw new DomainError('Suppression reason is required', 'INVALID_STATE_TRANSITION');
    this.transitionTo(ReconciliationStatus.SUPPRESSED);
    this._resolvedAt = now;
    this._resolvedBy = actorId;
    this._repairAction = `SUPPRESSED: ${reason}`;
  }

  escalate(actorId: string, now: Date): void {
    this.transitionTo(ReconciliationStatus.ESCALATED);
    this._metadata = Object.freeze({ ...this._metadata, escalatedBy: actorId, escalatedAt: now.toISOString() });
  }

  private transitionTo(next: ReconciliationStatus): void {
    const allowed = VALID_TRANSITIONS.get(this._status);
    if (!allowed || !allowed.has(next)) {
      throw new DomainError(
        `Invalid reconciliation status transition from ${this._status} to ${next}`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = next;
  }
}
