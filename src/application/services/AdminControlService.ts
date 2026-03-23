import { DomainError } from '../../domain/errors/DomainError';
import { SystemFreeze, FreezableEntityType } from '../../domain/entities/SystemFreeze';
import { AuditLogEntry } from '../../domain/entities/AuditLogEntry';
import { FreezeRepository } from '../../domain/interfaces/FreezeRepository';
import { AuditLogRepository } from '../../domain/interfaces/AuditLogRepository';
import { ManualReviewRepository } from '../../domain/interfaces/ManualReviewRepository';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';

/**
 * Application service for administrative operational control.
 *
 * Every method:
 * - Requires ADMIN role
 * - Logs an immutable audit entry
 * - Validates entity existence
 * - Validates state transitions
 */
export class AdminControlService {
  constructor(
    private readonly freezeRepo: FreezeRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly reviewRepo: ManualReviewRepository,
  ) {}

  async freezeEntity(
    actor: Actor,
    params: {
      id: string;
      entityType: FreezableEntityType;
      entityId: string;
      reason: string;
    },
  ): Promise<SystemFreeze> {
    const admin = AuthorizationGuard.requireAdmin(actor);

    if (!params.reason) {
      throw new DomainError('Freeze reason is required', 'FROZEN_ENTITY');
    }

    const freeze = SystemFreeze.create({
      id: params.id,
      entityType: params.entityType,
      entityId: params.entityId,
      reason: params.reason,
      frozenBy: admin.userId,
      createdAt: new Date(),
    });

    await this.freezeRepo.create(freeze);

    await this.logAudit(admin.userId, 'freeze_entity', params.entityType, params.entityId, {
      freezeId: freeze.id,
      reason: params.reason,
    });

    return freeze;
  }

  async unfreezeEntity(
    actor: Actor,
    params: { freezeId: string },
  ): Promise<void> {
    const admin = AuthorizationGuard.requireAdmin(actor);

    const freeze = await this.freezeRepo.findById(params.freezeId);
    if (!freeze) {
      throw new DomainError(
        `Freeze ${params.freezeId} not found`,
        'INVALID_STATE_TRANSITION',
      );
    }

    freeze.deactivate();
    await this.freezeRepo.save(freeze);

    await this.logAudit(admin.userId, 'unfreeze_entity', freeze.entityType, freeze.entityId, {
      freezeId: freeze.id,
    });
  }

  async assignReview(
    actor: Actor,
    params: { reviewId: string; assigneeId: string },
  ): Promise<void> {
    const admin = AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.reviewRepo.findById(params.reviewId);
    if (!reviewCase) {
      throw new DomainError(
        `Review case ${params.reviewId} not found`,
        'INVALID_REVIEW_STATE',
      );
    }

    const beforeStatus = reviewCase.status;
    reviewCase.assignTo(params.assigneeId);
    await this.reviewRepo.save(reviewCase);

    await this.logAudit(admin.userId, 'assign_review', 'ManualReviewCase', params.reviewId, {
      assigneeId: params.assigneeId,
      beforeStatus,
      afterStatus: reviewCase.status,
    });
  }

  async approveReview(
    actor: Actor,
    params: { reviewId: string; resolution: string },
  ): Promise<void> {
    const admin = AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.reviewRepo.findById(params.reviewId);
    if (!reviewCase) {
      throw new DomainError(
        `Review case ${params.reviewId} not found`,
        'INVALID_REVIEW_STATE',
      );
    }

    const beforeStatus = reviewCase.status;
    reviewCase.approve(admin.userId, params.resolution, new Date());
    await this.reviewRepo.save(reviewCase);

    await this.logAudit(admin.userId, 'approve_review', 'ManualReviewCase', params.reviewId, {
      resolution: params.resolution,
      beforeStatus,
      afterStatus: reviewCase.status,
    });
  }

  async rejectReview(
    actor: Actor,
    params: { reviewId: string; resolution: string },
  ): Promise<void> {
    const admin = AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.reviewRepo.findById(params.reviewId);
    if (!reviewCase) {
      throw new DomainError(
        `Review case ${params.reviewId} not found`,
        'INVALID_REVIEW_STATE',
      );
    }

    const beforeStatus = reviewCase.status;
    reviewCase.reject(admin.userId, params.resolution, new Date());
    await this.reviewRepo.save(reviewCase);

    await this.logAudit(admin.userId, 'reject_review', 'ManualReviewCase', params.reviewId, {
      resolution: params.resolution,
      beforeStatus,
      afterStatus: reviewCase.status,
    });
  }

  async addReviewNote(
    actor: Actor,
    params: { reviewId: string; note: string },
  ): Promise<void> {
    const admin = AuthorizationGuard.requireAdmin(actor);

    const reviewCase = await this.reviewRepo.findById(params.reviewId);
    if (!reviewCase) {
      throw new DomainError(
        `Review case ${params.reviewId} not found`,
        'INVALID_REVIEW_STATE',
      );
    }

    reviewCase.addNote(params.note);
    await this.reviewRepo.save(reviewCase);

    await this.logAudit(admin.userId, 'add_review_note', 'ManualReviewCase', params.reviewId, {
      note: params.note,
    });
  }

  private async logAudit(
    actorId: string,
    actionType: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      actorId,
      actionType,
      entityType,
      entityId,
      metadata,
      timestamp: new Date(),
    };

    await this.auditLogRepo.log(entry);
  }
}
