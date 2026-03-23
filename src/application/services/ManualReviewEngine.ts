import { DomainError } from '../../domain/errors/DomainError';
import { ManualReviewCase, FreezeTarget } from '../../domain/entities/ManualReviewCase';
import { ReviewSeverity } from '../../domain/enums/ReviewSeverity';
import { ReviewRepository } from '../../domain/interfaces/ReviewRepository';
import { ReviewFreezePolicy, FreezeCheckResult } from '../../domain/services/ReviewFreezePolicy';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';
import { AuditLog } from '../audit/AuditLog';

/**
 * Application service for manual review operations.
 *
 * Provides operational workflows around ManualReviewCase:
 * - case creation with freeze targets
 * - assignment to reviewers
 * - approval / rejection
 * - freeze status queries
 * - SLA / escalation queries
 */
export class ManualReviewEngine {
  private readonly reviewRepo: ReviewRepository;
  private readonly auditLog: AuditLog;

  constructor(reviewRepo: ReviewRepository, auditLog: AuditLog) {
    this.reviewRepo = reviewRepo;
    this.auditLog = auditLog;
  }

  /**
   * Create a new review case with explicit freeze targets.
   * Restricted to system actors or admin users.
   */
  async createCase(
    actor: Actor,
    params: {
      id: string;
      rentalId: string;
      severity: ReviewSeverity;
      reason: string;
      createdAt: Date;
      freezeTargets: FreezeTarget[];
    },
  ): Promise<ManualReviewCase> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

    const reviewCase = ManualReviewCase.create({
      id: params.id,
      rentalId: params.rentalId,
      severity: params.severity,
      reason: params.reason,
      createdAt: params.createdAt,
      freezeTargets: params.freezeTargets,
    });

    await this.reviewRepo.save(reviewCase);

    this.auditLog.record({
      actor,
      entityType: 'ManualReviewCase',
      entityId: reviewCase.id,
      action: 'create_review_case',
      outcome: 'success',
      afterState: `${reviewCase.status}:${reviewCase.severity}`,
      correlationId: params.rentalId,
    });

    return reviewCase;
  }

  /**
   * Assign a case to a reviewer. Transitions OPEN → IN_REVIEW.
   * Restricted to admin users.
   */
  async assignCase(
    actor: Actor,
    caseId: string,
    reviewerId: string,
  ): Promise<ManualReviewCase> {
    AuthorizationGuard.requireAdmin(actor);

    const cases = await this.findCaseById(caseId);

    const beforeStatus = cases.status;
    cases.assignTo(reviewerId);

    await this.reviewRepo.save(cases);

    this.auditLog.record({
      actor,
      entityType: 'ManualReviewCase',
      entityId: caseId,
      action: 'assign_review_case',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: `${cases.status}:assignedTo=${reviewerId}`,
    });

    return cases;
  }

  /**
   * Approve a case — clears the freeze on targeted entities.
   * Transitions IN_REVIEW → APPROVED.
   * Restricted to admin users.
   */
  async approveCase(
    actor: Actor,
    caseId: string,
    resolution: string,
    resolvedAt: Date,
  ): Promise<ManualReviewCase> {
    const adminActor = AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.findCaseById(caseId);

    const beforeStatus = reviewCase.status;
    reviewCase.approve(adminActor.userId, resolution, resolvedAt);

    await this.reviewRepo.save(reviewCase);

    this.auditLog.record({
      actor,
      entityType: 'ManualReviewCase',
      entityId: caseId,
      action: 'approve_review_case',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: reviewCase.status,
      correlationId: reviewCase.rentalId,
    });

    return reviewCase;
  }

  /**
   * Reject a case — entity remains frozen.
   * Transitions IN_REVIEW → REJECTED.
   * Restricted to admin users.
   */
  async rejectCase(
    actor: Actor,
    caseId: string,
    resolution: string,
    resolvedAt: Date,
  ): Promise<ManualReviewCase> {
    const adminActor = AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.findCaseById(caseId);

    const beforeStatus = reviewCase.status;
    reviewCase.reject(adminActor.userId, resolution, resolvedAt);

    await this.reviewRepo.save(reviewCase);

    this.auditLog.record({
      actor,
      entityType: 'ManualReviewCase',
      entityId: caseId,
      action: 'reject_review_case',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: reviewCase.status,
      correlationId: reviewCase.rentalId,
    });

    return reviewCase;
  }

  /**
   * Reopen a rejected case for further review.
   * Transitions REJECTED → OPEN.
   * Restricted to admin users.
   */
  async reopenCase(
    actor: Actor,
    caseId: string,
  ): Promise<ManualReviewCase> {
    AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.findCaseById(caseId);

    const beforeStatus = reviewCase.status;
    reviewCase.reopen();

    await this.reviewRepo.save(reviewCase);

    this.auditLog.record({
      actor,
      entityType: 'ManualReviewCase',
      entityId: caseId,
      action: 'reopen_review_case',
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: reviewCase.status,
      correlationId: reviewCase.rentalId,
    });

    return reviewCase;
  }

  // --- Freeze Queries ---

  /**
   * Check whether a user is frozen by any open review case.
   */
  async isUserFrozen(userId: string): Promise<FreezeCheckResult> {
    const cases = await this.reviewRepo.findUnresolvedByFreezeTarget('User', userId);
    return ReviewFreezePolicy.checkFreeze('User', userId, cases);
  }

  /**
   * Check whether a watch is frozen by any open review case.
   */
  async isWatchFrozen(watchId: string): Promise<FreezeCheckResult> {
    const cases = await this.reviewRepo.findUnresolvedByFreezeTarget('Watch', watchId);
    return ReviewFreezePolicy.checkFreeze('Watch', watchId, cases);
  }

  /**
   * Check whether a rental is frozen for release by any open review case.
   */
  async isRentalFrozen(rentalId: string): Promise<FreezeCheckResult> {
    const cases = await this.reviewRepo.findUnresolvedByRentalId(rentalId);
    return ReviewFreezePolicy.checkRentalFreeze(rentalId, cases);
  }

  // --- SLA Queries ---

  /**
   * Find all unresolved cases for a rental that are overdue.
   */
  async findOverdueCases(rentalId: string, now: Date): Promise<ManualReviewCase[]> {
    const cases = await this.reviewRepo.findUnresolvedByRentalId(rentalId);
    return cases.filter((c) => c.isOverdue(now));
  }

  /**
   * Find all unresolved cases for a rental that require escalation.
   */
  async findCasesRequiringEscalation(rentalId: string, now: Date): Promise<ManualReviewCase[]> {
    const cases = await this.reviewRepo.findUnresolvedByRentalId(rentalId);
    return cases.filter((c) => c.requiresEscalation(now));
  }

  // --- Private helpers ---

  private async findCaseById(caseId: string): Promise<ManualReviewCase> {
    const reviewCase = await this.reviewRepo.findById(caseId);
    if (!reviewCase) {
      throw new DomainError(
        `Review case ${caseId} not found`,
        'REVIEW_REQUIRED',
      );
    }
    return reviewCase;
  }
}
