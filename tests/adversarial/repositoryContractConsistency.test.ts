/**
 * PHASE F — REPOSITORY CONTRACT CONSISTENCY SUITE
 *
 * Validates that InMemory repository implementations obey
 * the same contract semantics required by the domain interfaces.
 * Tests active vs terminal classification, open claim detection,
 * and duplicate save / uniqueness enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryClaimRepository } from '../../src/infrastructure/repositories/InMemoryClaimRepository';
import { Rental } from '../../src/domain/entities/Rental';
import { InsuranceClaim } from '../../src/domain/entities/InsuranceClaim';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { DomainError } from '../../src/domain/errors/DomainError';
import { expectDomainError } from './helpers/adversarialFactories';

// ========================================================================
// RENTAL REPOSITORY CONTRACT
// ========================================================================

describe('Repository Contract: InMemoryRentalRepository', () => {
  let repo: InMemoryRentalRepository;

  beforeEach(() => {
    repo = new InMemoryRentalRepository();
  });

  // --- findActiveByWatchId ---

  describe('findActiveByWatchId', () => {
    it('returns only non-terminal rentals for a watch', async () => {
      const active = Rental.create({
        id: 'r-active', renterId: 'u1', watchId: 'w1',
        rentalPrice: 500, createdAt: new Date(),
      });
      await repo.save(active);

      const result = await repo.findActiveByWatchId('w1');
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('r-active');
    });

    it('excludes FUNDS_RELEASED_TO_OWNER rentals', async () => {
      const rental = Rental.create({
        id: 'r-released', renterId: 'u1', watchId: 'w1',
        rentalPrice: 500, createdAt: new Date(),
      });
      rental.startExternalPayment('pi_1');
      rental.markPaymentAuthorized();
      rental.markPaymentCaptured();
      rental.confirmReturn();
      rental.releaseFunds();
      await repo.save(rental);

      const result = await repo.findActiveByWatchId('w1');
      expect(result.length).toBe(0);
    });

    it('excludes REFUNDED rentals', async () => {
      const rental = Rental.create({
        id: 'r-refunded', renterId: 'u1', watchId: 'w1',
        rentalPrice: 500, createdAt: new Date(),
      });
      rental.startExternalPayment('pi_2');
      rental.markPaymentAuthorized();
      rental.markRefunded();
      await repo.save(rental);

      const result = await repo.findActiveByWatchId('w1');
      expect(result.length).toBe(0);
    });

    it('returns empty array for unknown watch', async () => {
      const result = await repo.findActiveByWatchId('unknown-watch');
      expect(result).toEqual([]);
    });

    it('includes AWAITING, AUTHORIZED, CAPTURED, DISPUTED rentals', async () => {
      const states = [
        { id: 'r-awaiting', prep: (r: Rental) => { r.startExternalPayment('pi_a'); } },
        { id: 'r-auth', prep: (r: Rental) => { r.startExternalPayment('pi_b'); r.markPaymentAuthorized(); } },
        { id: 'r-cap', prep: (r: Rental) => { r.startExternalPayment('pi_c'); r.markPaymentAuthorized(); r.markPaymentCaptured(); } },
      ];

      for (const s of states) {
        const rental = Rental.create({
          id: s.id, renterId: 'u1', watchId: `w-${s.id}`,
          rentalPrice: 500, createdAt: new Date(),
        });
        s.prep(rental);
        await repo.save(rental);
      }

      for (const s of states) {
        const result = await repo.findActiveByWatchId(`w-${s.id}`);
        expect(result.length).toBe(1);
        expect(result[0].id).toBe(s.id);
      }
    });
  });

  // --- findAllActive ---

  describe('findAllActive', () => {
    it('returns all non-terminal rentals across watches', async () => {
      const r1 = Rental.create({ id: 'r1', renterId: 'u1', watchId: 'w1', rentalPrice: 100, createdAt: new Date() });
      const r2 = Rental.create({ id: 'r2', renterId: 'u2', watchId: 'w2', rentalPrice: 200, createdAt: new Date() });
      await repo.save(r1);
      await repo.save(r2);

      const active = await repo.findAllActive();
      expect(active.length).toBe(2);
    });

    it('excludes terminal rentals from findAllActive', async () => {
      const r1 = Rental.create({ id: 'r-term', renterId: 'u1', watchId: 'w1', rentalPrice: 100, createdAt: new Date() });
      r1.startExternalPayment('pi_term');
      r1.markPaymentAuthorized();
      r1.markRefunded();
      await repo.save(r1);

      const active = await repo.findAllActive();
      expect(active.length).toBe(0);
    });
  });

  // --- save: OCC (optimistic concurrency control) ---

  describe('save: optimistic concurrency control', () => {
    it('rejects stale save with VERSION_CONFLICT', async () => {
      const rental = Rental.create({ id: 'r-occ', renterId: 'u1', watchId: 'w1', rentalPrice: 100, createdAt: new Date() });
      await repo.save(rental);

      // Load two copies
      const copy1 = await repo.findById('r-occ');
      const copy2 = await repo.findById('r-occ');

      // Mutate and save copy1
      copy1!.startExternalPayment('pi_occ_1');
      await repo.save(copy1!);

      // copy2 is now stale — save should fail
      copy2!.startExternalPayment('pi_occ_2');
      await expectDomainError(
        repo.save(copy2!),
        'VERSION_CONFLICT',
      );
    });
  });

  // --- save: double-rental prevention ---

  describe('save: double-rental prevention', () => {
    it('prevents saving two active rentals for the same watch', async () => {
      const r1 = Rental.create({ id: 'r-dup1', renterId: 'u1', watchId: 'w-dup', rentalPrice: 100, createdAt: new Date() });
      await repo.save(r1);

      const r2 = Rental.create({ id: 'r-dup2', renterId: 'u2', watchId: 'w-dup', rentalPrice: 200, createdAt: new Date() });
      await expectDomainError(
        repo.save(r2),
        'WATCH_ALREADY_RESERVED',
      );
    });

    it('allows new rental after previous rental reaches terminal state', async () => {
      const r1 = Rental.create({ id: 'r-term1', renterId: 'u1', watchId: 'w-term', rentalPrice: 100, createdAt: new Date() });
      r1.startExternalPayment('pi_t1');
      r1.markPaymentAuthorized();
      r1.markRefunded();
      await repo.save(r1);

      // Terminal — new rental should be allowed
      const r2 = Rental.create({ id: 'r-term2', renterId: 'u2', watchId: 'w-term', rentalPrice: 200, createdAt: new Date() });
      await repo.save(r2);

      const active = await repo.findActiveByWatchId('w-term');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('r-term2');
    });
  });

  // --- findActiveByWatchId and findAllActive consistency ---

  describe('findActiveByWatchId and findAllActive consistency', () => {
    it('findActiveByWatchId results are a subset of findAllActive', async () => {
      const r1 = Rental.create({ id: 'r-cons1', renterId: 'u1', watchId: 'w-cons', rentalPrice: 100, createdAt: new Date() });
      const r2 = Rental.create({ id: 'r-cons2', renterId: 'u2', watchId: 'w-other', rentalPrice: 200, createdAt: new Date() });
      await repo.save(r1);
      await repo.save(r2);

      const byWatch = await repo.findActiveByWatchId('w-cons');
      const allActive = await repo.findAllActive();

      const allActiveIds = new Set(allActive.map((r) => r.id));
      for (const r of byWatch) {
        expect(allActiveIds.has(r.id)).toBe(true);
      }
    });
  });
});

// ========================================================================
// CLAIM REPOSITORY CONTRACT
// ========================================================================

describe('Repository Contract: InMemoryClaimRepository', () => {
  let repo: InMemoryClaimRepository;

  beforeEach(() => {
    repo = new InMemoryClaimRepository();
  });

  function createClaim(id: string, rentalId: string, watchId: string): InsuranceClaim {
    return InsuranceClaim.create({
      id, policyId: 'pol-1', rentalId, watchId,
      claimAmount: 1000, reason: 'test', filedAt: new Date(),
    });
  }

  // --- findOpenByRentalId ---

  describe('findOpenByRentalId', () => {
    it('returns FILED claims as open', async () => {
      const claim = createClaim('c-filed', 'r1', 'w1');
      await repo.save(claim);

      const open = await repo.findOpenByRentalId('r1');
      expect(open.length).toBe(1);
    });

    it('returns UNDER_REVIEW claims as open', async () => {
      const claim = createClaim('c-review', 'r1', 'w1');
      claim.beginReview('reviewer-1');
      await repo.save(claim);

      const open = await repo.findOpenByRentalId('r1');
      expect(open.length).toBe(1);
    });

    it('returns APPROVED claims as open', async () => {
      const claim = createClaim('c-approved', 'r1', 'w1');
      claim.beginReview('reviewer-1');
      claim.approve(new Date(), 800);
      await repo.save(claim);

      const open = await repo.findOpenByRentalId('r1');
      expect(open.length).toBe(1);
    });

    it('excludes DENIED claims from open', async () => {
      const claim = createClaim('c-denied', 'r1', 'w1');
      claim.beginReview('reviewer-1');
      claim.deny(new Date(), 'Not covered');
      await repo.save(claim);

      const open = await repo.findOpenByRentalId('r1');
      expect(open.length).toBe(0);
    });

    it('excludes PAID_OUT claims from open', async () => {
      const claim = createClaim('c-paid', 'r1', 'w1');
      claim.beginReview('reviewer-1');
      claim.approve(new Date(), 800);
      claim.markPaidOut(new Date());
      await repo.save(claim);

      const open = await repo.findOpenByRentalId('r1');
      expect(open.length).toBe(0);
    });

    it('returns empty for rental with no claims', async () => {
      const open = await repo.findOpenByRentalId('nonexistent');
      expect(open).toEqual([]);
    });
  });

  // --- findOpenByWatchId ---

  describe('findOpenByWatchId', () => {
    it('returns only open claims for the specified watch', async () => {
      const c1 = createClaim('c1', 'r1', 'w1');
      const c2 = createClaim('c2', 'r2', 'w1');
      c2.beginReview('reviewer-1');
      c2.deny(new Date(), 'nope');

      await repo.save(c1);
      await repo.save(c2);

      const open = await repo.findOpenByWatchId('w1');
      expect(open.length).toBe(1);
      expect(open[0].id).toBe('c1');
    });
  });

  // --- save: OCC ---

  describe('save: optimistic concurrency control', () => {
    it('rejects stale claim save with VERSION_CONFLICT', async () => {
      const claim = createClaim('c-occ', 'r1', 'w1');
      await repo.save(claim);

      const copy1 = await repo.findById('c-occ');
      const copy2 = await repo.findById('c-occ');

      copy1!.beginReview('rev-1');
      await repo.save(copy1!);

      copy2!.beginReview('rev-2');
      await expectDomainError(
        repo.save(copy2!),
        'VERSION_CONFLICT',
      );
    });
  });

  // --- findOpenByRentalId and entity isOpen() consistency ---

  describe('findOpenByRentalId consistent with InsuranceClaim.isOpen()', () => {
    it('repository query matches entity isOpen() for all lifecycle states', async () => {
      const states: { id: string; prep: (c: InsuranceClaim) => void; expectedOpen: boolean }[] = [
        { id: 'c-s1', prep: () => {}, expectedOpen: true },
        { id: 'c-s2', prep: (c) => c.beginReview('r1'), expectedOpen: true },
        { id: 'c-s3', prep: (c) => { c.beginReview('r1'); c.approve(new Date(), 500); }, expectedOpen: true },
        { id: 'c-s4', prep: (c) => { c.beginReview('r1'); c.deny(new Date(), 'no'); }, expectedOpen: false },
        { id: 'c-s5', prep: (c) => { c.beginReview('r1'); c.approve(new Date(), 500); c.markPaidOut(new Date()); }, expectedOpen: false },
      ];

      for (const s of states) {
        const claim = createClaim(s.id, 'r-consistency', 'w-consistency');
        s.prep(claim);
        await repo.save(claim);
      }

      const openFromRepo = await repo.findOpenByRentalId('r-consistency');
      const openIds = new Set(openFromRepo.map((c) => c.id));

      for (const s of states) {
        const claim = await repo.findById(s.id);
        expect(claim!.isOpen()).toBe(s.expectedOpen);
        expect(openIds.has(s.id)).toBe(s.expectedOpen);
      }
    });
  });
});
