import { DomainError } from '../errors/DomainError';
import { ReviewSeverity } from '../enums/ReviewSeverity';

export class ManualReviewCase {
  readonly id: string;
  readonly rentalId: string;
  readonly severity: ReviewSeverity;
  readonly reason: string;
  readonly createdAt: Date;
  private _resolved: boolean;
  private _resolvedBy: string | null;
  private _resolvedAt: Date | null;
  private _resolution: string | null;

  constructor(params: {
    id: string;
    rentalId: string;
    severity: ReviewSeverity;
    reason: string;
    createdAt: Date;
  }) {
    if (!params.id) {
      throw new DomainError(
        'Review case ID is required',
        'REVIEW_REQUIRED',
      );
    }

    if (!params.rentalId) {
      throw new DomainError(
        'Rental ID is required for review case',
        'REVIEW_REQUIRED',
      );
    }

    if (!params.reason) {
      throw new DomainError(
        'Review reason is required',
        'REVIEW_REQUIRED',
      );
    }

    this.id = params.id;
    this.rentalId = params.rentalId;
    this.severity = params.severity;
    this.reason = params.reason;
    this.createdAt = params.createdAt;
    this._resolved = false;
    this._resolvedBy = null;
    this._resolvedAt = null;
    this._resolution = null;
  }

  get resolved(): boolean {
    return this._resolved;
  }

  get resolvedBy(): string | null {
    return this._resolvedBy;
  }

  get resolvedAt(): Date | null {
    return this._resolvedAt;
  }

  get resolution(): string | null {
    return this._resolution;
  }

  isBlocking(): boolean {
    return !this._resolved && (
      this.severity === ReviewSeverity.HIGH ||
      this.severity === ReviewSeverity.CRITICAL
    );
  }

  resolve(resolvedBy: string, resolution: string, resolvedAt: Date): void {
    if (this._resolved) {
      throw new DomainError(
        'Review case is already resolved',
        'INVALID_STATE_TRANSITION',
      );
    }

    if (!resolvedBy) {
      throw new DomainError(
        'Resolver ID is required',
        'REVIEW_REQUIRED',
      );
    }

    if (!resolution) {
      throw new DomainError(
        'Resolution description is required',
        'REVIEW_REQUIRED',
      );
    }

    this._resolved = true;
    this._resolvedBy = resolvedBy;
    this._resolvedAt = resolvedAt;
    this._resolution = resolution;
  }
}
