import { describe, it, expect, beforeEach } from 'vitest';
import { AdminControlService } from '../../src/application/services/AdminControlService';
import { InMemoryFreezeRepository } from '../../src/infrastructure/repositories/InMemoryFreezeRepository';
import { InMemoryAuditLogRepository } from '../../src/infrastructure/repositories/InMemoryAuditLogRepository';
import { InMemoryManualReviewRepository } from '../../src/infrastructure/repositories/InMemoryManualReviewRepository';
import { ManualReviewCase } from '../../src/domain/entities/ManualReviewCase';
import { ReviewSeverity } from '../../src/domain/enums/ReviewSeverity';
import { ReviewStatus } from '../../src/domain/enums/ReviewStatus';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { DomainError } from '../../src/domain/errors/DomainError';
import { Actor, UserActor } from '../../src/application/auth/Actor';

const adminActor: UserActor = {
  kind: 'user',
  userId: 'admin-1',
  role: MarketplaceRole.ADMIN,
};

const renterActor: UserActor = {
  kind: 'user',
  userId: 'renter-1',
  role: MarketplaceRole.RENTER,
};

const systemActor: Actor = {
  kind: 'system',
  source: 'test',
};

function makeReviewCase(id: string = 'review-1'): ManualReviewCase {
  return ManualReviewCase.create({
    id,
    rentalId: 'rental-1',
    severity: ReviewSeverity.HIGH,
    reason: 'Suspicious activity detected',
    createdAt: new Date('2025-01-01'),
    freezeTargets: [{ entityType: 'Rental', entityId: 'rental-1' }],
  });
}

describe('AdminControlService', () => {
  let freezeRepo: InMemoryFreezeRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let reviewRepo: InMemoryManualReviewRepository;
  let service: AdminControlService;

  beforeEach(() => {
    freezeRepo = new InMemoryFreezeRepository();
    auditLogRepo = new InMemoryAuditLogRepository();
    reviewRepo = new InMemoryManualReviewRepository();
    service = new AdminControlService(freezeRepo, auditLogRepo, reviewRepo);
  });

  // --- freeze/unfreeze ---

  describe('freezeEntity', () => {
    it('creates a freeze and logs audit', async () => {
      const freeze = await service.freezeEntity(adminActor, {
        id: 'freeze-1',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'Suspicious',
      });

      expect(freeze.active).toBe(true);
      expect(freeze.entityType).toBe('USER');

      const stored = await freezeRepo.findById('freeze-1');
      expect(stored).not.toBeNull();
      expect(stored!.active).toBe(true);

      const auditEntries = auditLogRepo.entries();
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].actionType).toBe('freeze_entity');
      expect(auditEntries[0].actorId).toBe('admin-1');
    });

    it('rejects non-admin actor', async () => {
      await expect(
        service.freezeEntity(renterActor, {
          id: 'freeze-1',
          entityType: 'USER',
          entityId: 'user-1',
          reason: 'Suspicious',
        }),
      ).rejects.toThrow(DomainError);
    });

    it('rejects system actor', async () => {
      await expect(
        service.freezeEntity(systemActor, {
          id: 'freeze-1',
          entityType: 'USER',
          entityId: 'user-1',
          reason: 'Suspicious',
        }),
      ).rejects.toThrow(DomainError);
    });

    it('rejects empty reason', async () => {
      await expect(
        service.freezeEntity(adminActor, {
          id: 'freeze-1',
          entityType: 'USER',
          entityId: 'user-1',
          reason: '',
        }),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('unfreezeEntity', () => {
    it('deactivates freeze and logs audit', async () => {
      await service.freezeEntity(adminActor, {
        id: 'freeze-1',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'Suspicious',
      });

      await service.unfreezeEntity(adminActor, { freezeId: 'freeze-1' });

      const stored = await freezeRepo.findById('freeze-1');
      expect(stored!.active).toBe(false);

      const auditEntries = auditLogRepo.entries();
      expect(auditEntries.length).toBe(2);
      expect(auditEntries[1].actionType).toBe('unfreeze_entity');
    });

    it('throws on non-existent freeze', async () => {
      await expect(
        service.unfreezeEntity(adminActor, { freezeId: 'nonexistent' }),
      ).rejects.toThrow(DomainError);
    });

    it('throws on already inactive freeze', async () => {
      await service.freezeEntity(adminActor, {
        id: 'freeze-1',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'Suspicious',
      });
      await service.unfreezeEntity(adminActor, { freezeId: 'freeze-1' });

      await expect(
        service.unfreezeEntity(adminActor, { freezeId: 'freeze-1' }),
      ).rejects.toThrow(DomainError);
    });

    it('rejects non-admin actor', async () => {
      await expect(
        service.unfreezeEntity(renterActor, { freezeId: 'freeze-1' }),
      ).rejects.toThrow(DomainError);
    });
  });

  // --- review management ---

  describe('assignReview', () => {
    it('assigns reviewer and logs audit', async () => {
      const reviewCase = makeReviewCase();
      await reviewRepo.create(reviewCase);

      await service.assignReview(adminActor, {
        reviewId: 'review-1',
        assigneeId: 'reviewer-1',
      });

      const stored = await reviewRepo.findById('review-1');
      expect(stored!.status).toBe(ReviewStatus.IN_REVIEW);
      expect(stored!.assignedTo).toBe('reviewer-1');

      const auditEntries = auditLogRepo.entries();
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].actionType).toBe('assign_review');
    });

    it('throws on non-existent review', async () => {
      await expect(
        service.assignReview(adminActor, {
          reviewId: 'nonexistent',
          assigneeId: 'reviewer-1',
        }),
      ).rejects.toThrow(DomainError);
    });

    it('rejects non-admin', async () => {
      await expect(
        service.assignReview(renterActor, {
          reviewId: 'review-1',
          assigneeId: 'reviewer-1',
        }),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('approveReview', () => {
    it('approves review in IN_REVIEW state', async () => {
      const reviewCase = makeReviewCase();
      await reviewRepo.create(reviewCase);
      await service.assignReview(adminActor, {
        reviewId: 'review-1',
        assigneeId: 'reviewer-1',
      });

      await service.approveReview(adminActor, {
        reviewId: 'review-1',
        resolution: 'Verified legitimate',
      });

      const stored = await reviewRepo.findById('review-1');
      expect(stored!.status).toBe(ReviewStatus.APPROVED);
      expect(stored!.resolvedBy).toBe('admin-1');
    });

    it('throws on OPEN state (not IN_REVIEW)', async () => {
      const reviewCase = makeReviewCase();
      await reviewRepo.create(reviewCase);

      await expect(
        service.approveReview(adminActor, {
          reviewId: 'review-1',
          resolution: 'Approved',
        }),
      ).rejects.toThrow(DomainError);
    });

    it('rejects non-admin', async () => {
      await expect(
        service.approveReview(renterActor, {
          reviewId: 'review-1',
          resolution: 'Approved',
        }),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('rejectReview', () => {
    it('rejects review in IN_REVIEW state', async () => {
      const reviewCase = makeReviewCase();
      await reviewRepo.create(reviewCase);
      await service.assignReview(adminActor, {
        reviewId: 'review-1',
        assigneeId: 'reviewer-1',
      });

      await service.rejectReview(adminActor, {
        reviewId: 'review-1',
        resolution: 'Denied access',
      });

      const stored = await reviewRepo.findById('review-1');
      expect(stored!.status).toBe(ReviewStatus.REJECTED);
    });

    it('throws on non-existent review', async () => {
      await expect(
        service.rejectReview(adminActor, {
          reviewId: 'nonexistent',
          resolution: 'Denied',
        }),
      ).rejects.toThrow(DomainError);
    });
  });

  describe('addReviewNote', () => {
    it('adds note and logs audit', async () => {
      const reviewCase = makeReviewCase();
      await reviewRepo.create(reviewCase);

      await service.addReviewNote(adminActor, {
        reviewId: 'review-1',
        note: 'Checked user history',
      });

      const auditEntries = auditLogRepo.entries();
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].actionType).toBe('add_review_note');
    });

    it('throws on non-existent review', async () => {
      await expect(
        service.addReviewNote(adminActor, {
          reviewId: 'nonexistent',
          note: 'A note',
        }),
      ).rejects.toThrow(DomainError);
    });

    it('rejects non-admin', async () => {
      await expect(
        service.addReviewNote(renterActor, {
          reviewId: 'review-1',
          note: 'A note',
        }),
      ).rejects.toThrow(DomainError);
    });
  });

  // --- audit invariants ---

  describe('audit logging invariants', () => {
    it('every admin action produces an audit entry', async () => {
      const reviewCase = makeReviewCase();
      await reviewRepo.create(reviewCase);

      // Freeze
      await service.freezeEntity(adminActor, {
        id: 'f1',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'test',
      });

      // Unfreeze
      await service.unfreezeEntity(adminActor, { freezeId: 'f1' });

      // Assign
      await service.assignReview(adminActor, {
        reviewId: 'review-1',
        assigneeId: 'r1',
      });

      // Note
      await service.addReviewNote(adminActor, {
        reviewId: 'review-1',
        note: 'note',
      });

      // Approve
      await service.approveReview(adminActor, {
        reviewId: 'review-1',
        resolution: 'ok',
      });

      const entries = auditLogRepo.entries();
      expect(entries.length).toBe(5);
      expect(entries.map((e) => e.actionType)).toEqual([
        'freeze_entity',
        'unfreeze_entity',
        'assign_review',
        'add_review_note',
        'approve_review',
      ]);

      // All entries have the admin actor
      entries.forEach((e) => {
        expect(e.actorId).toBe('admin-1');
      });
    });

    it('no silent success on invalid input', async () => {
      // Freeze with empty reason
      await expect(
        service.freezeEntity(adminActor, {
          id: 'f1',
          entityType: 'USER',
          entityId: 'user-1',
          reason: '',
        }),
      ).rejects.toThrow();

      // No audit entry for failed operation
      expect(auditLogRepo.entries().length).toBe(0);
    });
  });
});
