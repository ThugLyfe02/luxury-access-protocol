import { DomainError } from '../errors/DomainError';
import { ReconciliationSeverity } from '../enums/ReconciliationSeverity';

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface RunSummary {
  readonly totalChecked: number;
  readonly totalFindings: number;
  readonly findingsBySeverity: Readonly<Record<string, number>>;
  readonly repairedCount: number;
  readonly escalatedCount: number;
  readonly failedChecks: number;
}

export class ReconciliationRun {
  readonly id: string;
  readonly startedAt: Date;
  readonly triggeredBy: string;
  private _status: RunStatus;
  private _completedAt: Date | null;
  private _totalChecked: number;
  private _totalFindings: number;
  private _findingsBySeverity: Record<string, number>;
  private _repairedCount: number;
  private _escalatedCount: number;
  private _failedChecks: number;
  private _error: string | null;

  private constructor(params: {
    id: string;
    startedAt: Date;
    triggeredBy: string;
    status: RunStatus;
    completedAt: Date | null;
    totalChecked: number;
    totalFindings: number;
    findingsBySeverity: Record<string, number>;
    repairedCount: number;
    escalatedCount: number;
    failedChecks: number;
    error: string | null;
  }) {
    this.id = params.id;
    this.startedAt = params.startedAt;
    this.triggeredBy = params.triggeredBy;
    this._status = params.status;
    this._completedAt = params.completedAt;
    this._totalChecked = params.totalChecked;
    this._totalFindings = params.totalFindings;
    this._findingsBySeverity = { ...params.findingsBySeverity };
    this._repairedCount = params.repairedCount;
    this._escalatedCount = params.escalatedCount;
    this._failedChecks = params.failedChecks;
    this._error = params.error;
  }

  static create(params: { id: string; triggeredBy: string; startedAt: Date }): ReconciliationRun {
    if (!params.id) throw new DomainError('Run ID is required', 'INVALID_STATE_TRANSITION');
    if (!params.triggeredBy) throw new DomainError('triggeredBy is required', 'INVALID_STATE_TRANSITION');

    return new ReconciliationRun({
      ...params,
      status: 'RUNNING',
      completedAt: null,
      totalChecked: 0,
      totalFindings: 0,
      findingsBySeverity: {},
      repairedCount: 0,
      escalatedCount: 0,
      failedChecks: 0,
      error: null,
    });
  }

  static restore(params: {
    id: string;
    startedAt: Date;
    triggeredBy: string;
    status: RunStatus;
    completedAt: Date | null;
    totalChecked: number;
    totalFindings: number;
    findingsBySeverity: Record<string, number>;
    repairedCount: number;
    escalatedCount: number;
    failedChecks: number;
    error: string | null;
  }): ReconciliationRun {
    return new ReconciliationRun(params);
  }

  get status(): RunStatus { return this._status; }
  get completedAt(): Date | null { return this._completedAt; }
  get error(): string | null { return this._error; }
  get summary(): RunSummary {
    return {
      totalChecked: this._totalChecked,
      totalFindings: this._totalFindings,
      findingsBySeverity: { ...this._findingsBySeverity },
      repairedCount: this._repairedCount,
      escalatedCount: this._escalatedCount,
      failedChecks: this._failedChecks,
    };
  }

  recordChecked(): void {
    this._totalChecked++;
  }

  recordFinding(severity: ReconciliationSeverity): void {
    this._totalFindings++;
    this._findingsBySeverity[severity] = (this._findingsBySeverity[severity] ?? 0) + 1;
  }

  recordRepair(): void {
    this._repairedCount++;
  }

  recordEscalation(): void {
    this._escalatedCount++;
  }

  recordFailedCheck(): void {
    this._failedChecks++;
  }

  complete(now: Date): void {
    if (this._status !== 'RUNNING') {
      throw new DomainError(`Cannot complete run in ${this._status} status`, 'INVALID_STATE_TRANSITION');
    }
    this._status = 'COMPLETED';
    this._completedAt = now;
  }

  fail(error: string, now: Date): void {
    if (this._status !== 'RUNNING') {
      throw new DomainError(`Cannot fail run in ${this._status} status`, 'INVALID_STATE_TRANSITION');
    }
    this._status = 'FAILED';
    this._completedAt = now;
    this._error = error;
  }
}
