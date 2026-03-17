import { DomainError } from '../errors/DomainError';
import { ReviewSeverity } from '../enums/ReviewSeverity';
import { ReviewStatus } from '../enums/ReviewStatus';

const ALL_REVIEW_SEVERITIES: ReadonlySet<string> = new Set(
  Object.values(ReviewSeverity),
);

const ALL_REVIEW_STATUSES: ReadonlySet<string> = new Set(
  Object.values(ReviewStatus),
);

/**
 * Valid status transitions for the review FSM.
 * OPEN → IN_REVIEW → APPROVED | REJECTED
 * REJECTED → OPEN (reopen path)
 */
const VALID_STATUS_TRANSITIONS: ReadonlyMap<ReviewStatus, ReadonlySet<ReviewStatus>> =
  new Map([
    [ReviewStatus.OPEN, new Set([ReviewStatus.IN_REVIEW])],
    [ReviewStatus.IN_REVIEW, new Set([ReviewStatus.APPROVED, ReviewStatus.REJECTED])],
    [ReviewStatus.APPROVED, new Set<ReviewStatus>()],
    [ReviewStatus.REJECTED, new Set([ReviewStatus.OPEN])],
  ]);

/**
 * SLA deadlines by severity (in milliseconds from case creation).
 * CRITICAL: 2 hours
 * HIGH: 8 hours
 * MEDIUM: 24 hours
 * LOW: 72 hours
 */
const SLA_DEADLINES_MS: ReadonlyMap<ReviewSeverity, number> = new Map([
  [ReviewSeverity.CRITICAL, 2 * 60 * 60 * 1000],
  [ReviewSeverity.HIGH, 8 * 60 * 60 * 1000],
  [ReviewSeverity.MEDIUM, 24 * 60 * 60 * 1000],
  [ReviewSeverity.LOW, 72 * 60 * 60 * 1000],
]);

/**
 * Freeze target — identifies which entity is frozen by this review case.
 * A case can freeze a specific rental, a user, or a watch.
 */
export interface FreezeTarget {
  readonly entityType: 'Rental' | 'User' | 'Watch';
  readonly entityId: string;
}

export class ManualReviewCase {
  readonly id: string;
  readonly rentalId: string;
  readonly severity: ReviewSeverity;
  readonly reason: string;
  readonly createdAt: Date;
  private _status: ReviewStatus;
  private _assignedTo: string | null;
  private _resolvedBy: string | null;
  private _resolvedAt: Date | null;
  private _resolution: string | null;
  private _version: number;
  private readonly _freezeTargets: FreezeTarget[];
  private readonly _slaDeadline: Date;
  private readonly _notes: string[];

  private constructor(params: {
    id: string;
    rentalId: string;
    severity: ReviewSeverity;
    reason: string;
    createdAt: Date;
    status: ReviewStatus;
    assignedTo: string | null;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    resolution: string | null;
    version: number;
    freezeTargets: FreezeTarget[];
    slaDeadline: Date;
    notes?: readonly string[];
  }) {
    this.id = params.id;
    this.rentalId = params.rentalId;
    this.severity = params.severity;
    this.reason = params.reason;
    this.createdAt = params.createdAt;
    this._status = params.status;
    this._assignedTo = params.assignedTo;
    this._resolvedBy = params.resolvedBy;
    this._resolvedAt = params.resolvedAt;
    this._resolution = params.resolution;
    this._version = params.version;
    this._freezeTargets = [...params.freezeTargets];
    this._slaDeadline = params.slaDeadline;
    this._notes = [...(params.notes ?? [])];
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
    freezeTargets?: FreezeTarget[];
  }): ManualReviewCase {
    ManualReviewCase.validate(params);

    const slaMs = SLA_DEADLINES_MS.get(params.severity) ?? 72 * 60 * 60 * 1000;
    const slaDeadline = new Date(params.createdAt.getTime() + slaMs);

    return new ManualReviewCase({
      ...params,
      status: ReviewStatus.OPEN,
      assignedTo: null,
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
      version: 0,
      freezeTargets: params.freezeTargets ?? [],
      slaDeadline,
    });
  }

  static restore(params: {
    id: string;
    rentalId: string;
    severity: string;
    reason: string;
    createdAt: Date;
    status: string;
    assignedTo: string | null;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    resolution: string | null;
    version: number;
    freezeTargets: FreezeTarget[];
    slaDeadline: Date;
    // Legacy compat: accept 'resolved' for restore from old records
    resolved?: boolean;
  }): ManualReviewCase {
    ManualReviewCase.validate(params);

    if (!ALL_REVIEW_SEVERITIES.has(params.severity)) {
      throw new DomainError(
        `Unknown review severity from persistence: ${params.severity}`,
        'REVIEW_REQUIRED',
      );
    }

    if (!ALL_REVIEW_STATUSES.has(params.status)) {
      throw new DomainError(
        `Unknown review status from persistence: ${params.status}`,
        'INVALID_STATE_TRANSITION',
      );
    }

    const status = params.status as ReviewStatus;
    const isTerminal = status === ReviewStatus.APPROVED || status === ReviewStatus.REJECTED;

    // Structural consistency: terminal cases must have resolver, date, and resolution
    if (isTerminal) {
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

    // Structural consistency: non-terminal cases must NOT have resolution fields
    if (!isTerminal) {
      if (params.resolvedBy !== null || params.resolvedAt !== null || params.resolution !== null) {
        throw new DomainError(
          'Unresolved review case must not have resolution fields set',
          'INVALID_STATE_TRANSITION',
        );
      }
    }

    if (!Number.isInteger(params.version) || params.version < 0) {
      throw new DomainError(
        'Version must be a non-negative integer',
        'VERSION_CONFLICT',
      );
    }

    return new ManualReviewCase({
      ...params,
      severity: params.severity as ReviewSeverity,
      status,
      freezeTargets: params.freezeTargets,
      slaDeadline: params.slaDeadline,
    });
  }

  // --- Getters ---

  get status(): ReviewStatus {
    return this._status;
  }

  /**
   * Backward-compatible resolved check.
   * A case is "resolved" if it has reached a terminal status.
   */
  get resolved(): boolean {
    return this._status === ReviewStatus.APPROVED || this._status === ReviewStatus.REJECTED;
  }

  get assignedTo(): string | null {
    return this._assignedTo;
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

  get version(): number {
    return this._version;
  }

  get freezeTargets(): ReadonlyArray<FreezeTarget> {
    return this._freezeTargets;
  }

  get slaDeadline(): Date {
    return this._slaDeadline;
  }

  get notes(): ReadonlyArray<string> {
    return this._notes;
  }

  // --- Query Methods ---

  /**
   * A case is blocking if it is not resolved AND severity is HIGH or CRITICAL.
   * Blocking cases prevent releases and may prevent new rentals.
   */
  isBlocking(): boolean {
    return !this.resolved && (
      this.severity === ReviewSeverity.HIGH ||
      this.severity === ReviewSeverity.CRITICAL
    );
  }

  /**
   * Whether this case is still open (not yet in a terminal state).
   */
  isOpen(): boolean {
    return !this.resolved;
  }

  /**
   * Whether this case has breached its SLA deadline.
   */
  isOverdue(now: Date): boolean {
    return !this.resolved && now > this._slaDeadline;
  }

  /**
   * Whether this case requires escalation.
   * Escalation triggers: CRITICAL + overdue, or CRITICAL + unassigned.
   */
  requiresEscalation(now: Date): boolean {
    if (this.resolved) return false;
    if (this.severity === ReviewSeverity.CRITICAL) {
      return this._assignedTo === null || this.isOverdue(now);
    }
    if (this.severity === ReviewSeverity.HIGH && this.isOverdue(now)) {
      return true;
    }
    return false;
  }

  /**
   * Whether this case freezes a specific entity.
   */
  freezesEntity(entityType: string, entityId: string): boolean {
    if (this.resolved) return false;
    return this._freezeTargets.some(
      (t) => t.entityType === entityType && t.entityId === entityId,
    );
  }

  // --- Mutation Methods (FSM transitions) ---

  /**
   * Assign the case to a reviewer. Transitions from OPEN to IN_REVIEW.
   */
  assignTo(reviewerId: string): void {
    if (!reviewerId) {
      throw new DomainError(
        'Reviewer ID is required',
        'REVIEW_REQUIRED',
      );
    }

    this.transitionTo(ReviewStatus.IN_REVIEW);
    this._assignedTo = reviewerId;
  }

  /**
   * Approve the case — the reviewed entity is cleared.
   * Transitions from IN_REVIEW to APPROVED.
   */
  approve(resolvedBy: string, resolution: string, resolvedAt: Date): void {
    this.validateResolutionFields(resolvedBy, resolution);
    this.transitionTo(ReviewStatus.APPROVED);
    this._resolvedBy = resolvedBy;
    this._resolvedAt = resolvedAt;
    this._resolution = resolution;
  }

  /**
   * Reject the case — the reviewed entity remains frozen / action denied.
   * Transitions from IN_REVIEW to REJECTED.
   */
  reject(resolvedBy: string, resolution: string, resolvedAt: Date): void {
    this.validateResolutionFields(resolvedBy, resolution);
    this.transitionTo(ReviewStatus.REJECTED);
    this._resolvedBy = resolvedBy;
    this._resolvedAt = resolvedAt;
    this._resolution = resolution;
  }

  /**
   * Reopen a previously rejected case for further review.
   * Transitions from REJECTED to OPEN. Clears resolution fields.
   */
  reopen(): void {
    this.transitionTo(ReviewStatus.OPEN);
    this._assignedTo = null;
    this._resolvedBy = null;
    this._resolvedAt = null;
    this._resolution = null;
  }

  /**
   * Add a note to the review case. Notes are append-only.
   */
  addNote(note: string): void {
    if (!note || note.trim().length === 0) {
      throw new DomainError(
        'Note content is required',
        'REVIEW_REQUIRED',
      );
    }
    this._notes.push(note.trim());
    this._version += 1;
  }

  /**
   * Mark the case as in review without assigning. Transitions from OPEN to IN_REVIEW.
   */
  markInReview(): void {
    this.transitionTo(ReviewStatus.IN_REVIEW);
  }

  /**
   * Legacy resolve method — maps to approve() for backward compatibility.
   */
  resolve(resolvedBy: string, resolution: string, resolvedAt: Date): void {
    if (this._status === ReviewStatus.OPEN) {
      // Auto-transition through IN_REVIEW for backward compat
      this._status = ReviewStatus.IN_REVIEW;
      this._version += 1;
    }
    this.approve(resolvedBy, resolution, resolvedAt);
  }

  // --- Private helpers ---

  private transitionTo(nextStatus: ReviewStatus): void {
    const allowed = VALID_STATUS_TRANSITIONS.get(this._status);
    if (!allowed || !allowed.has(nextStatus)) {
      throw new DomainError(
        `Invalid review status transition from ${this._status} to ${nextStatus}`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = nextStatus;
    this._version += 1;
  }

  private validateResolutionFields(resolvedBy: string, resolution: string): void {
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
  }
}
