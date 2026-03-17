import { describe, it, expect } from 'vitest';
import { ManualReviewCase } from '../../src/domain/entities/ManualReviewCase';
import { ReviewSeverity } from '../../src/domain/enums/ReviewSeverity';
import { ReviewStatus } from '../../src/domain/enums/ReviewStatus';
import { DomainError } from '../../src/domain/errors/DomainError';

function makeCase(overrides?: { severity?: ReviewSeverity }): ManualReviewCase {
  return ManualReviewCase.create({
    id: 'review-1',
    rentalId: 'rental-1',
    severity: overrides?.severity ?? ReviewSeverity.HIGH,
    reason: 'Test review reason',
    createdAt: new Date('2025-01-01'),
    freezeTargets: [{ entityType: 'Rental', entityId: 'rental-1' }],
  });
}

describe('ManualReviewCase', () => {
  describe('creation', () => {
    it('creates in OPEN status', () => {
      const c = makeCase();
      expect(c.status).toBe(ReviewStatus.OPEN);
      expect(c.version).toBe(0);
      expect(c.notes).toEqual([]);
    });

    it('rejects missing id', () => {
      expect(() =>
        ManualReviewCase.create({
          id: '',
          rentalId: 'rental-1',
          severity: ReviewSeverity.HIGH,
          reason: 'reason',
          createdAt: new Date(),
        }),
      ).toThrow(DomainError);
    });

    it('rejects missing reason', () => {
      expect(() =>
        ManualReviewCase.create({
          id: 'id',
          rentalId: 'rental-1',
          severity: ReviewSeverity.HIGH,
          reason: '',
          createdAt: new Date(),
        }),
      ).toThrow(DomainError);
    });
  });

  describe('state transitions', () => {
    it('OPEN → IN_REVIEW via assignTo', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      expect(c.status).toBe(ReviewStatus.IN_REVIEW);
      expect(c.assignedTo).toBe('admin-1');
    });

    it('IN_REVIEW → APPROVED', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      c.approve('admin-1', 'All good', new Date());
      expect(c.status).toBe(ReviewStatus.APPROVED);
      expect(c.resolved).toBe(true);
    });

    it('IN_REVIEW → REJECTED', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      c.reject('admin-1', 'Denied', new Date());
      expect(c.status).toBe(ReviewStatus.REJECTED);
      expect(c.resolved).toBe(true);
    });

    it('REJECTED → OPEN via reopen', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      c.reject('admin-1', 'Denied', new Date());
      c.reopen();
      expect(c.status).toBe(ReviewStatus.OPEN);
      expect(c.resolved).toBe(false);
    });

    it('rejects OPEN → APPROVED (invalid transition)', () => {
      const c = makeCase();
      expect(() =>
        c.approve('admin-1', 'Approved', new Date()),
      ).toThrow(DomainError);
    });

    it('rejects OPEN → REJECTED (invalid transition)', () => {
      const c = makeCase();
      expect(() =>
        c.reject('admin-1', 'Denied', new Date()),
      ).toThrow(DomainError);
    });

    it('rejects APPROVED → anything', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      c.approve('admin-1', 'OK', new Date());
      expect(() => c.assignTo('admin-2')).toThrow(DomainError);
      expect(() => c.reopen()).toThrow(DomainError);
    });

    it('rejects OPEN → OPEN (no self-transition)', () => {
      const c = makeCase();
      expect(() => c.reopen()).toThrow(DomainError);
    });

    it('rejects IN_REVIEW → IN_REVIEW (no re-assign via transition)', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      expect(() => c.assignTo('admin-2')).toThrow(DomainError);
    });
  });

  describe('markInReview', () => {
    it('transitions from OPEN to IN_REVIEW', () => {
      const c = makeCase();
      c.markInReview();
      expect(c.status).toBe(ReviewStatus.IN_REVIEW);
    });
  });

  describe('notes', () => {
    it('adds notes to the case', () => {
      const c = makeCase();
      c.addNote('First observation');
      c.addNote('Second observation');
      expect(c.notes).toEqual(['First observation', 'Second observation']);
    });

    it('rejects empty notes', () => {
      const c = makeCase();
      expect(() => c.addNote('')).toThrow(DomainError);
      expect(() => c.addNote('   ')).toThrow(DomainError);
    });

    it('increments version on note add', () => {
      const c = makeCase();
      const v0 = c.version;
      c.addNote('A note');
      expect(c.version).toBe(v0 + 1);
    });
  });

  describe('query methods', () => {
    it('isBlocking for HIGH severity open case', () => {
      const c = makeCase({ severity: ReviewSeverity.HIGH });
      expect(c.isBlocking()).toBe(true);
    });

    it('isBlocking for CRITICAL severity open case', () => {
      const c = makeCase({ severity: ReviewSeverity.CRITICAL });
      expect(c.isBlocking()).toBe(true);
    });

    it('not blocking for LOW severity', () => {
      const c = makeCase({ severity: ReviewSeverity.LOW });
      expect(c.isBlocking()).toBe(false);
    });

    it('not blocking once resolved', () => {
      const c = makeCase({ severity: ReviewSeverity.HIGH });
      c.assignTo('admin-1');
      c.approve('admin-1', 'OK', new Date());
      expect(c.isBlocking()).toBe(false);
    });

    it('freezesEntity matches freeze targets', () => {
      const c = makeCase();
      expect(c.freezesEntity('Rental', 'rental-1')).toBe(true);
      expect(c.freezesEntity('Rental', 'other')).toBe(false);
    });

    it('freezesEntity returns false once resolved', () => {
      const c = makeCase();
      c.assignTo('admin-1');
      c.approve('admin-1', 'OK', new Date());
      expect(c.freezesEntity('Rental', 'rental-1')).toBe(false);
    });
  });
});
