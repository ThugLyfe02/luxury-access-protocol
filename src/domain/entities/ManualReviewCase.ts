import { DomainError } from '../errors/DomainError';
import { ReviewSeverity } from '../enums/ReviewSeverity';

const ALL_REVIEW_SEVERITIES: ReadonlySet<string> = new Set(
  Object.values(ReviewSeverity),
);

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

  private constructor(params: {
    id: string;
    rentalId: string;
    severity: ReviewSeverity;
    reason: string;
    createdAt: Date;
    resolved: boolean;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    resolution: string | null;
  }) {
    this.id = params.id;
    this.rentalId = params.rentalId;
    this.severity = params.severity;
    this.reason = params.reason;
    this.createdAt = params.createdAt;
    this._resolved = params.resolved;
    this._resolvedBy = params.resolvedBy;
    this._resolvedAt = params.resolvedAt;
    this._resolution = params.resolution;
  }

  private static validate(params: {
    id: string;
    rentalId: string;
    reason: string;
  }): void {
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
  }

  static create(params: {
    id: string;
    rentalId: string;
    severity: ReviewSeverity;
    reason: string;
    createdAt: Date;
  }): ManualReviewCase {
    ManualReviewCase.validate(params);

    return new ManualReviewCase({
      ...params,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
    });
  }

  static restore(params: {
    id: string;
    rentalId: string;
    severity: string;
    reason: string;
    createdAt: Date;
    resolved: boolean;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    resolution: string | null;
  }): ManualReviewCase {
    ManualReviewCase.validate(params);

    if (!ALL_REVIEW_SEVERITIES.has(params.severity)) {
      throw new DomainError(
        `Unknown review severity from persistence: ${params.severity}`,
        'REVIEW_REQUIRED',
      );
    }

    // Structural consistency: resolved cases must have resolver, date, and resolution
    if (params.resolved) {
      if (!params.resolvedBy) {
        throw new DomainError(
          'Resolved review case must have a resolvedBy ID',
          'REVIEW_REQUIRED',
        );
      }
      if (params.resolvedAt === null) {
        throw new DomainError(
          'Resolved review case must have a resolvedAt date',
          'REVIEW_REQUIRED',
        );
      }
      if (!params.resolution) {
        throw new DomainError(
          'Resolved review case must have a resolution description',
          'REVIEW_REQUIRED',
        );
      }
    }

    // Structural consistency: unresolved cases must NOT have resolution fields
    if (!params.resolved) {
      if (params.resolvedBy !== null || params.resolvedAt !== null || params.resolution !== null) {
        throw new DomainError(
          'Unresolved review case must not have resolution fields set',
          'INVALID_STATE_TRANSITION',
        );
      }
    }

    return new ManualReviewCase({
      ...params,
      severity: params.severity as ReviewSeverity,
    });
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
