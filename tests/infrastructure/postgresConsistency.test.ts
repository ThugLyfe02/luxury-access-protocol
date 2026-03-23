import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryClaimRepository } from '../../src/infrastructure/repositories/InMemoryClaimRepository';
import { InMemoryReviewRepository } from '../../src/infrastructure/repositories/InMemoryReviewRepository';
import { InMemoryFreezeRepository } from '../../src/infrastructure/repositories/InMemoryFreezeRepository';
import { InMemoryAuditLogRepository } from '../../src/infrastructure/repositories/InMemoryAuditLogRepository';
import { InMemoryManualReviewRepository } from '../../src/infrastructure/repositories/InMemoryManualReviewRepository';
import { InMemoryIdempotencyStore } from '../../src/http/idempotency/IdempotencyStore';
import { InMemoryProcessedWebhookEventStore } from '../../src/http/webhookController';
import { Rental } from '../../src/domain/entities/Rental';
import { InsuranceClaim } from '../../src/domain/entities/InsuranceClaim';
import { ManualReviewCase } from '../../src/domain/entities/ManualReviewCase';
import { SystemFreeze } from '../../src/domain/entities/SystemFreeze';
import { ReviewSeverity } from '../../src/domain/enums/ReviewSeverity';
import { DomainError } from '../../src/domain/errors/DomainError';
import { computePayloadHash } from '../../src/http/idempotency/IdempotencyStore';

/**
 * Distributed consistency tests.
 *
 * These tests verify invariants that MUST hold in a multi-instance,
 * crash-safe production system. They use in-memory implementations
 * that enforce the same constraints as the Postgres implementations.
 *
 * In production, these guarantees are backed by:
 * - UNIQUE indexes (double-rental prevention, idempotency keys, webhook events)
 * - Optimistic concurrency (version columns with WHERE version = X)
 * - Append-only tables (audit logs)
 * - Transactions (atomic multi-table operations)
 */

function makeRental(id: string, watchId: string): Rental {
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId,
    rentalPrice: 500,
    createdAt: new Date('2025-01-01'),
  });
  rental.startExternalPayment(`pi_${id}`);
  return rental;
}

function makeTerminalRental(id: string, watchId: string): Rental {
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId,
    rentalPrice: 500,
    createdAt: new Date('2025-01-01'),
  });
  rental.startExternalPayment(`pi_${id}`);
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  rental.confirmReturn();
  rental.releaseFunds();
  return rental;
}

describe('Distributed Consistency Invariants', () => {
  // =============================================
  // DOUBLE RENTAL PREVENTION
  // =============================================
  describe('double rental prevention', () => {
    let rentalRepo: InMemoryRentalRepository;

    beforeEach(() => {
      rentalRepo = new InMemoryRentalRepository();
    });

    it('prevents two active rentals for the same watch', async () => {
      const rental1 = makeRental('rental-1', 'watch-1');
      await rentalRepo.save(rental1);

      const rental2 = makeRental('rental-2', 'watch-1');
      await expect(rentalRepo.save(rental2)).rejects.toThrow(DomainError);

      try {
        await rentalRepo.save(rental2);
      } catch (e) {
        expect((e as DomainError).code).toBe('WATCH_ALREADY_RESERVED');
      }
    });

    it('allows new rental after previous rental is terminal', async () => {
      const rental1 = makeTerminalRental('rental-1', 'watch-1');
      await rentalRepo.save(rental1);

      const rental2 = makeRental('rental-2', 'watch-1');
      await expect(rentalRepo.save(rental2)).resolves.toBeUndefined();
    });

    it('allows rentals for different watches', async () => {
      const rental1 = makeRental('rental-1', 'watch-1');
      const rental2 = makeRental('rental-2', 'watch-2');

      await rentalRepo.save(rental1);
      await expect(rentalRepo.save(rental2)).resolves.toBeUndefined();
    });
  });

  // =============================================
  // OPTIMISTIC CONCURRENCY (VERSION CONFLICTS)
  // =============================================
  describe('version conflicts', () => {
    it('rental version conflict on concurrent modification', async () => {
      const rentalRepo = new InMemoryRentalRepository();
      const rental = makeRental('rental-1', 'watch-1');
      await rentalRepo.save(rental);

      // Load the same rental twice (simulating two instances)
      const instance1 = await rentalRepo.findById('rental-1');
      const instance2 = await rentalRepo.findById('rental-1');

      // Instance 1 modifies and saves
      instance1!.markPaymentAuthorized();
      await rentalRepo.save(instance1!);

      // Instance 2 modifies and tries to save — conflict
      instance2!.markPaymentAuthorized();
      await expect(rentalRepo.save(instance2!)).rejects.toThrow(DomainError);

      try {
        await rentalRepo.save(instance2!);
      } catch (e) {
        expect((e as DomainError).code).toBe('VERSION_CONFLICT');
      }
    });

    it('claim version conflict on concurrent modification', async () => {
      const claimRepo = new InMemoryClaimRepository();
      const claim = InsuranceClaim.create({
        id: 'claim-1',
        policyId: 'policy-1',
        rentalId: 'rental-1',
        watchId: 'watch-1',
        claimAmount: 1000,
        reason: 'Damage detected',
        filedAt: new Date('2025-01-01'),
      });
      await claimRepo.save(claim);

      const c1 = await claimRepo.findById('claim-1');
      const c2 = await claimRepo.findById('claim-1');

      c1!.beginReview('reviewer-1');
      await claimRepo.save(c1!);

      c2!.beginReview('reviewer-2');
      await expect(claimRepo.save(c2!)).rejects.toThrow(DomainError);
    });

    it('review case version conflict on concurrent modification', async () => {
      const reviewRepo = new InMemoryReviewRepository();
      const reviewCase = ManualReviewCase.create({
        id: 'review-1',
        rentalId: 'rental-1',
        severity: ReviewSeverity.HIGH,
        reason: 'Investigation needed',
        createdAt: new Date('2025-01-01'),
        freezeTargets: [],
      });
      await reviewRepo.save(reviewCase);

      const r1 = await reviewRepo.findById('review-1');
      const r2 = await reviewRepo.findById('review-1');

      r1!.assignTo('admin-1');
      await reviewRepo.save(r1!);

      r2!.assignTo('admin-2');
      await expect(reviewRepo.save(r2!)).rejects.toThrow(DomainError);
    });
  });

  // =============================================
  // DUPLICATE WEBHOOK EVENT PREVENTION
  // =============================================
  describe('webhook event deduplication', () => {
    it('prevents double-processing of webhook events', async () => {
      const store = new InMemoryProcessedWebhookEventStore();

      await store.add('evt_001', 'rental-1', 'payment_authorized');
      expect(await store.has('evt_001')).toBe(true);
      expect(await store.has('evt_002')).toBe(false);
    });

    it('survives conceptual restart (data persists in store)', async () => {
      const store = new InMemoryProcessedWebhookEventStore();
      await store.add('evt_001', 'rental-1', 'payment_authorized');

      // Same store instance simulates persistent storage
      expect(await store.has('evt_001')).toBe(true);
    });
  });

  // =============================================
  // IDEMPOTENCY KEY COLLISIONS
  // =============================================
  describe('idempotency key handling', () => {
    it('same key + same hash returns cached response', async () => {
      const store = new InMemoryIdempotencyStore();
      const payload = { renterId: 'r1', watchId: 'w1', rentalPrice: 500 };
      const hash = computePayloadHash(payload);

      await store.save({
        key: 'idem-1',
        payloadHash: hash,
        responseStatus: 201,
        responseBody: '{"success":true}',
        createdAt: new Date(),
      });

      const existing = await store.find('idem-1');
      expect(existing).not.toBeNull();
      expect(existing!.payloadHash).toBe(hash);
      expect(existing!.responseStatus).toBe(201);
    });

    it('same key + different hash is detectable (conflict)', async () => {
      const store = new InMemoryIdempotencyStore();
      const payload1 = { renterId: 'r1', watchId: 'w1', rentalPrice: 500 };
      const payload2 = { renterId: 'r1', watchId: 'w2', rentalPrice: 1000 };
      const hash1 = computePayloadHash(payload1);
      const hash2 = computePayloadHash(payload2);

      await store.save({
        key: 'idem-1',
        payloadHash: hash1,
        responseStatus: 201,
        responseBody: '{"success":true}',
        createdAt: new Date(),
      });

      const existing = await store.find('idem-1');
      expect(existing).not.toBeNull();
      expect(existing!.payloadHash).not.toBe(hash2);
      // Caller detects mismatch and returns 409
    });

    it('new key returns null (proceed)', async () => {
      const store = new InMemoryIdempotencyStore();
      const existing = await store.find('nonexistent');
      expect(existing).toBeNull();
    });
  });

  // =============================================
  // CONCURRENT RENTAL ATTEMPTS
  // =============================================
  describe('concurrent rental initiation', () => {
    it('only one concurrent rental succeeds for the same watch', async () => {
      const rentalRepo = new InMemoryRentalRepository();

      const rental1 = makeRental('rental-1', 'watch-1');
      const rental2 = makeRental('rental-2', 'watch-1');

      // Simulate concurrent saves — only one should succeed
      const results = await Promise.allSettled([
        rentalRepo.save(rental1),
        rentalRepo.save(rental2),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const error = (rejected[0] as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe('WATCH_ALREADY_RESERVED');
    });
  });

  // =============================================
  // AUDIT LOG IMMUTABILITY
  // =============================================
  describe('audit log immutability', () => {
    it('entries are append-only and never modified', async () => {
      const repo = new InMemoryAuditLogRepository();

      await repo.log({
        id: 'entry-1',
        actorId: 'admin-1',
        actionType: 'freeze_entity',
        entityType: 'USER',
        entityId: 'user-1',
        metadata: { reason: 'suspicious' },
        timestamp: new Date('2025-01-01'),
      });

      await repo.log({
        id: 'entry-2',
        actorId: 'admin-1',
        actionType: 'unfreeze_entity',
        entityType: 'USER',
        entityId: 'user-1',
        metadata: {},
        timestamp: new Date('2025-01-02'),
      });

      const entries = repo.entries();
      expect(entries.length).toBe(2);
      expect(entries[0].id).toBe('entry-1');
      expect(entries[1].id).toBe('entry-2');

      // Entries are frozen — attempting to modify should fail
      expect(() => {
        (entries[0] as any).actorId = 'hacker';
      }).toThrow();
    });

    it('find by entity returns correct entries', async () => {
      const repo = new InMemoryAuditLogRepository();

      await repo.log({
        id: 'e1',
        actorId: 'admin-1',
        actionType: 'freeze_entity',
        entityType: 'USER',
        entityId: 'user-1',
        metadata: {},
        timestamp: new Date(),
      });

      await repo.log({
        id: 'e2',
        actorId: 'admin-2',
        actionType: 'freeze_entity',
        entityType: 'USER',
        entityId: 'user-2',
        metadata: {},
        timestamp: new Date(),
      });

      const user1Entries = await repo.findByEntityId('user-1');
      expect(user1Entries.length).toBe(1);
      expect(user1Entries[0].actorId).toBe('admin-1');
    });
  });

  // =============================================
  // FREEZE REPOSITORY CONSISTENCY
  // =============================================
  describe('freeze repository consistency', () => {
    it('prevents duplicate freeze creation', async () => {
      const repo = new InMemoryFreezeRepository();
      const freeze = SystemFreeze.create({
        id: 'freeze-1',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'test',
        frozenBy: 'admin-1',
        createdAt: new Date(),
      });

      await repo.create(freeze);
      await expect(repo.create(freeze)).rejects.toThrow(DomainError);
    });

    it('findActive only returns active freezes', async () => {
      const repo = new InMemoryFreezeRepository();

      const f1 = SystemFreeze.create({
        id: 'f1',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'active freeze',
        frozenBy: 'admin-1',
        createdAt: new Date(),
      });
      await repo.create(f1);

      const f2 = SystemFreeze.create({
        id: 'f2',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'will be deactivated',
        frozenBy: 'admin-1',
        createdAt: new Date(),
      });
      await repo.create(f2);

      // Deactivate f2
      const loaded = await repo.findById('f2');
      loaded!.deactivate();
      await repo.save(loaded!);

      const active = await repo.findActive('USER', 'user-1');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('f1');
    });
  });

  // =============================================
  // MANUAL REVIEW REPOSITORY CONSISTENCY
  // =============================================
  describe('manual review repository consistency', () => {
    it('prevents duplicate review case creation', async () => {
      const repo = new InMemoryManualReviewRepository();
      const reviewCase = ManualReviewCase.create({
        id: 'review-1',
        rentalId: 'rental-1',
        severity: ReviewSeverity.HIGH,
        reason: 'test',
        createdAt: new Date(),
        freezeTargets: [{ entityType: 'Rental', entityId: 'rental-1' }],
      });

      await repo.create(reviewCase);
      await expect(repo.create(reviewCase)).rejects.toThrow(DomainError);
    });

    it('findOpenByEntity returns only non-terminal cases', async () => {
      const repo = new InMemoryManualReviewRepository();

      const open = ManualReviewCase.create({
        id: 'review-open',
        rentalId: 'rental-1',
        severity: ReviewSeverity.HIGH,
        reason: 'open case',
        createdAt: new Date(),
        freezeTargets: [{ entityType: 'User', entityId: 'user-1' }],
      });
      await repo.create(open);

      const resolved = ManualReviewCase.create({
        id: 'review-resolved',
        rentalId: 'rental-1',
        severity: ReviewSeverity.HIGH,
        reason: 'resolved case',
        createdAt: new Date(),
        freezeTargets: [{ entityType: 'User', entityId: 'user-1' }],
      });
      resolved.assignTo('admin-1');
      resolved.approve('admin-1', 'OK', new Date());
      await repo.create(resolved);

      const openCases = await repo.findOpenByEntity('User', 'user-1');
      expect(openCases.length).toBe(1);
      expect(openCases[0].id).toBe('review-open');
    });
  });

  // =============================================
  // CROSS-INSTANCE STATE IDENTITY
  // =============================================
  describe('cross-instance state identity', () => {
    it('rental state is deterministic across load/save cycles', async () => {
      const repo = new InMemoryRentalRepository();
      const rental = makeRental('rental-1', 'watch-1');
      await repo.save(rental);

      const loaded = await repo.findById('rental-1');
      expect(loaded!.escrowStatus).toBe(rental.escrowStatus);
      expect(loaded!.version).toBe(rental.version);
      expect(loaded!.externalPaymentIntentId).toBe(rental.externalPaymentIntentId);
    });

    it('claim state survives serialization round-trip', async () => {
      const repo = new InMemoryClaimRepository();
      const claim = InsuranceClaim.create({
        id: 'claim-1',
        policyId: 'pol-1',
        rentalId: 'rental-1',
        watchId: 'watch-1',
        claimAmount: 5000,
        reason: 'Crystal scratched',
        filedAt: new Date('2025-06-15'),
      });
      await repo.save(claim);

      const loaded = await repo.findById('claim-1');
      expect(loaded!.status).toBe(claim.status);
      expect(loaded!.claimAmount).toBe(claim.claimAmount);
      expect(loaded!.version).toBe(claim.version);
    });
  });

  // =============================================
  // RESTART SIMULATION
  // =============================================
  describe('restart simulation', () => {
    it('data persists across repository lifetime (simulated restart)', async () => {
      // In production, Postgres persists data across process restarts.
      // In-memory stores simulate this by being the same instance.
      const rentalRepo = new InMemoryRentalRepository();
      const webhookStore = new InMemoryProcessedWebhookEventStore();
      const idempotencyStore = new InMemoryIdempotencyStore();

      // Pre-restart writes
      const rental = makeRental('rental-1', 'watch-1');
      await rentalRepo.save(rental);
      await webhookStore.add('evt_001', 'rental-1', 'payment_authorized');
      await idempotencyStore.save({
        key: 'idem-1',
        payloadHash: 'abc123',
        responseStatus: 201,
        responseBody: '{}',
        createdAt: new Date(),
      });

      // Post-restart reads (same instance = simulated persistence)
      expect(await rentalRepo.findById('rental-1')).not.toBeNull();
      expect(await webhookStore.has('evt_001')).toBe(true);
      expect(await idempotencyStore.find('idem-1')).not.toBeNull();
    });
  });
});
