import { DomainError } from '../errors/DomainError';

export class ConditionReport {
  readonly id: string;
  readonly rentalId: string;
  readonly watchId: string;
  readonly inspectorId: string;
  readonly watchMarketValue: number;
  readonly conditionGrade: number;
  readonly damageNotes: string;
  readonly createdAt: Date;
  private _approved: boolean;

  constructor(params: {
    id: string;
    rentalId: string;
    watchId: string;
    inspectorId: string;
    watchMarketValue: number;
    conditionGrade: number;
    damageNotes: string;
    createdAt: Date;
  }) {
    if (!params.id) {
      throw new DomainError(
        'Condition report ID is required',
        'CONDITION_REPORT_INVALID',
      );
    }

    if (!params.rentalId) {
      throw new DomainError(
        'Rental ID is required for condition report',
        'CONDITION_REPORT_INVALID',
      );
    }

    if (!params.watchId) {
      throw new DomainError(
        'Watch ID is required for condition report',
        'CONDITION_REPORT_INVALID',
      );
    }

    if (!params.inspectorId) {
      throw new DomainError(
        'Inspector ID is required for condition report',
        'CONDITION_REPORT_INVALID',
      );
    }

    if (params.conditionGrade < 1 || params.conditionGrade > 10) {
      throw new DomainError(
        'Condition grade must be between 1 and 10',
        'CONDITION_REPORT_INVALID',
      );
    }

    if (params.watchMarketValue <= 0) {
      throw new DomainError(
        'Watch market value must be positive',
        'INVALID_VALUATION',
      );
    }

    this.id = params.id;
    this.rentalId = params.rentalId;
    this.watchId = params.watchId;
    this.inspectorId = params.inspectorId;
    this.watchMarketValue = params.watchMarketValue;
    this.conditionGrade = params.conditionGrade;
    this.damageNotes = params.damageNotes;
    this.createdAt = params.createdAt;
    this._approved = false;
  }

  get approved(): boolean {
    return this._approved;
  }

  requiresThirdPartyInspection(): boolean {
    return this.watchMarketValue >= 5000;
  }

  approve(approverId: string): void {
    if (!approverId) {
      throw new DomainError(
        'Approver ID is required',
        'CONDITION_REPORT_INVALID',
      );
    }

    if (this.requiresThirdPartyInspection() && approverId === this.inspectorId) {
      throw new DomainError(
        'High-value watch condition reports cannot be self-approved',
        'CONDITION_REPORT_INVALID',
      );
    }

    this._approved = true;
  }

  hasDamage(): boolean {
    return this.conditionGrade < 7 || this.damageNotes.length > 0;
  }
}
