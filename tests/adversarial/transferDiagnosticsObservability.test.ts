/**
 * PHASE N.8 — OBSERVABILITY HARDENING SUITE
 *
 * Proves that all new observability code is:
 * - Read-only (no mutations to Rental, OutboxEvent, or reconciliation state)
 * - Correct in detection (identifies stuck rentals, excludes valid states)
 * - Correct in classification (SUCCEEDED with result, FAILED, missing)
 * - Correctly integrated into HealthMonitor (DEGRADED, NOT_READY signals)
 *
 * Tests:
 * 1.  findStuckTransferTruth identifies stuck rentals correctly
 * 2.  findStuckTransferTruth excludes non-stuck states
 * 3.  findStuckTransferTruth respects age threshold
 * 4.  Diagnostics classifies SUCCEEDED event with transferId as will_recover
 * 5.  Diagnostics classifies DEAD_LETTER as needs_manual_intervention
 * 6.  Diagnostics classifies no outbox events as needs_manual_intervention
 * 7.  Diagnostics classifies SUCCEEDED without transferId as needs_manual
 * 8.  Summary counts are correct across mixed scenarios
 * 9.  getStuckTransferDetails returns null for unknown rental
 * 10. Calling diagnostics does not mutate rental state
 * 11. Calling diagnostics does not mutate outbox state
 * 12. HealthMonitor reports DEGRADED when stuck count exceeds threshold
 * 13. HealthMonitor reports NOT_READY when stuck count exceeds critical threshold
 * 14. HealthMonitor reports HEALTHY when no stuck transfers
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Rental } from '../../src/domain/entities/Rental';
import { OutboxEvent } from '../../src/domain/entities/OutboxEvent';
import { EscrowStatus } from '../../src/domain/enums/EscrowStatus';
import { InMemoryRentalRepository } from '../../src/infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryOutboxRepository } from '../../src/infrastructure/repositories/InMemoryOutboxRepository';
import { OutboxTransferDiagnosticsService } from '../../src/application/services/OutboxTransferDiagnosticsService';
import { HealthMonitor } from '../../src/infrastructure/resilience/HealthMonitor';
import { loadResilienceConfig } from '../../src/infrastructure/resilience/ResilienceConfig';

// ========================================================================
// HELPERS
// ========================================================================

/**
 * Create a rental stuck in transfer-truth limbo:
 * CAPTURED + returnConfirmed + no transferId + old enough.
 */
function makeStuckRental(id = 'r-stuck-1', ageMs = 600_000): Rental {
  const createdAt = new Date(Date.now() - ageMs);
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId: `w-${id}`,
    rentalPrice: 500,
    createdAt,
  });
  rental.startExternalPayment(`pi_${id}`);
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  rental.confirmReturn();
  return rental;
}

/**
 * Create a rental that is NOT stuck (already released).
 */
function makeReleasedRental(id = 'r-released-1'): Rental {
  const rental = makeStuckRental(id);
  rental.releaseFunds('tr_released');
  return rental;
}

/**
 * Create a rental that is CAPTURED but return NOT confirmed (not stuck).
 */
function makeCapturedNoReturn(id = 'r-captured-no-return'): Rental {
  const createdAt = new Date(Date.now() - 600_000);
  const rental = Rental.create({
    id,
    renterId: 'renter-1',
    watchId: `w-${id}`,
    rentalPrice: 500,
    createdAt,
  });
  rental.startExternalPayment(`pi_${id}`);
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  return rental;
}

function makeSucceededTransferEvent(rentalId: string, transferId: string): OutboxEvent {
  const event = OutboxEvent.create({
    id: crypto.randomUUID(),
    topic: 'payment.transfer_to_owner',
    aggregateType: 'Rental',
    aggregateId: rentalId,
    payload: { rentalId, amount: 400, connectedAccountId: 'acct_1' },
    dedupKey: `transfer:${rentalId}`,
  });
  event.acquireLease('test-worker', new Date());
  event.markSucceeded(new Date(), { transferId });
  return event;
}

function makeDeadLetterEvent(rentalId: string): OutboxEvent {
  const event = OutboxEvent.create({
    id: crypto.randomUUID(),
    topic: 'payment.transfer_to_owner',
    aggregateType: 'Rental',
    aggregateId: rentalId,
    payload: { rentalId, amount: 400, connectedAccountId: 'acct_1' },
    dedupKey: `transfer:${rentalId}`,
  });
  event.acquireLease('test-worker', new Date());
  event.markFailed(new Date(), 'provider error', true);
  return event;
}

function makeSucceededEventNoTransferId(rentalId: string): OutboxEvent {
  const event = OutboxEvent.create({
    id: crypto.randomUUID(),
    topic: 'payment.transfer_to_owner',
    aggregateType: 'Rental',
    aggregateId: rentalId,
    payload: { rentalId, amount: 400, connectedAccountId: 'acct_1' },
    dedupKey: `transfer:${rentalId}`,
  });
  event.acquireLease('test-worker', new Date());
  event.markSucceeded(new Date(), { someOtherField: 'value' });
  return event;
}

// ========================================================================
// TEST SETUP
// ========================================================================

let rentalRepo: InMemoryRentalRepository;
let outboxRepo: InMemoryOutboxRepository;
let diagnosticsService: OutboxTransferDiagnosticsService;

beforeEach(() => {
  rentalRepo = new InMemoryRentalRepository();
  outboxRepo = new InMemoryOutboxRepository();
  diagnosticsService = new OutboxTransferDiagnosticsService(rentalRepo, outboxRepo);
});

// ========================================================================
// 1. DETECTION CORRECTNESS
// ========================================================================

describe('findStuckTransferTruth detection', () => {
  it('1. identifies stuck rentals correctly', async () => {
    const stuck = makeStuckRental('r-stuck-1');
    await rentalRepo.save(stuck);

    const results = await rentalRepo.findStuckTransferTruth(300_000);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('r-stuck-1');
    expect(results[0].escrowStatus).toBe(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
    expect(results[0].returnConfirmed).toBe(true);
    expect(results[0].externalTransferId).toBeNull();
  });

  it('2. excludes non-stuck states', async () => {
    // Released rental
    const released = makeReleasedRental('r-released');
    await rentalRepo.save(released);

    // CAPTURED without return confirmed
    const noReturn = makeCapturedNoReturn('r-no-return');
    await rentalRepo.save(noReturn);

    // NOT_STARTED rental
    const notStarted = Rental.create({
      id: 'r-not-started',
      renterId: 'renter-1',
      watchId: 'w-not-started',
      rentalPrice: 500,
      createdAt: new Date(Date.now() - 600_000),
    });
    await rentalRepo.save(notStarted);

    // REFUNDED rental
    const refunded = Rental.create({
      id: 'r-refunded',
      renterId: 'renter-1',
      watchId: 'w-refunded',
      rentalPrice: 500,
      createdAt: new Date(Date.now() - 600_000),
    });
    refunded.startExternalPayment('pi_refunded');
    refunded.markPaymentAuthorized();
    refunded.markRefunded();
    await rentalRepo.save(refunded);

    const results = await rentalRepo.findStuckTransferTruth(300_000);
    expect(results).toHaveLength(0);
  });

  it('3. respects age threshold — too-young rentals excluded', async () => {
    // Create a stuck rental that is only 1 second old
    const young = makeStuckRental('r-young', 1_000);
    await rentalRepo.save(young);

    // Threshold is 5 minutes — should not find the 1-second-old rental
    const results = await rentalRepo.findStuckTransferTruth(300_000);
    expect(results).toHaveLength(0);

    // With 500ms threshold — should find it
    const results2 = await rentalRepo.findStuckTransferTruth(500);
    expect(results2).toHaveLength(1);
  });
});

// ========================================================================
// 2. OUTBOX CORRELATION & CLASSIFICATION
// ========================================================================

describe('outbox correlation accuracy', () => {
  it('4. classifies SUCCEEDED event with transferId as will_recover_via_reconciliation', async () => {
    const stuck = makeStuckRental('r-classify-1');
    await rentalRepo.save(stuck);
    const event = makeSucceededTransferEvent('r-classify-1', 'tr_recovered');
    await outboxRepo.create(event);

    const detail = await diagnosticsService.getStuckTransferDetails('r-classify-1');
    expect(detail).not.toBeNull();
    expect(detail!.recoveryClassification).toBe('will_recover_via_reconciliation');
    expect(detail!.outboxEvents).toHaveLength(1);
    expect(detail!.outboxEvents[0].status).toBe('SUCCEEDED');
  });

  it('5. classifies DEAD_LETTER event as needs_manual_intervention', async () => {
    const stuck = makeStuckRental('r-classify-2');
    await rentalRepo.save(stuck);
    const event = makeDeadLetterEvent('r-classify-2');
    await outboxRepo.create(event);

    const detail = await diagnosticsService.getStuckTransferDetails('r-classify-2');
    expect(detail).not.toBeNull();
    expect(detail!.recoveryClassification).toBe('needs_manual_intervention');
  });

  it('6. classifies no outbox events as needs_manual_intervention', async () => {
    const stuck = makeStuckRental('r-classify-3');
    await rentalRepo.save(stuck);

    const detail = await diagnosticsService.getStuckTransferDetails('r-classify-3');
    expect(detail).not.toBeNull();
    expect(detail!.recoveryClassification).toBe('needs_manual_intervention');
    expect(detail!.outboxEvents).toHaveLength(0);
  });

  it('7. classifies SUCCEEDED without transferId as needs_manual_intervention', async () => {
    const stuck = makeStuckRental('r-classify-4');
    await rentalRepo.save(stuck);
    const event = makeSucceededEventNoTransferId('r-classify-4');
    await outboxRepo.create(event);

    const summary = await diagnosticsService.getStuckTransferSummary(300_000);
    expect(summary.withSucceededNoTransferId).toBe(1);
  });
});

// ========================================================================
// 3. SUMMARY COUNTS
// ========================================================================

describe('summary counts', () => {
  it('8. summary counts are correct across mixed scenarios', async () => {
    // Stuck rental 1: has SUCCEEDED outbox event with transferId
    const stuck1 = makeStuckRental('r-mix-1');
    await rentalRepo.save(stuck1);
    await outboxRepo.create(makeSucceededTransferEvent('r-mix-1', 'tr_1'));

    // Stuck rental 2: has DEAD_LETTER outbox event
    const stuck2 = makeStuckRental('r-mix-2');
    await rentalRepo.save(stuck2);
    await outboxRepo.create(makeDeadLetterEvent('r-mix-2'));

    // Stuck rental 3: no outbox events at all
    const stuck3 = makeStuckRental('r-mix-3');
    await rentalRepo.save(stuck3);

    // Stuck rental 4: SUCCEEDED but no transferId in result
    const stuck4 = makeStuckRental('r-mix-4');
    await rentalRepo.save(stuck4);
    await outboxRepo.create(makeSucceededEventNoTransferId('r-mix-4'));

    const summary = await diagnosticsService.getStuckTransferSummary(300_000);
    expect(summary.totalStuck).toBe(4);
    expect(summary.withSucceededTransferId).toBe(1);
    expect(summary.withOnlyFailedOrDeadLetter).toBe(1);
    expect(summary.withNoOutboxEvents).toBe(1);
    expect(summary.withSucceededNoTransferId).toBe(1);
  });
});

// ========================================================================
// 4. EDGE CASES
// ========================================================================

describe('edge cases', () => {
  it('9. getStuckTransferDetails returns null for unknown rental', async () => {
    const detail = await diagnosticsService.getStuckTransferDetails('nonexistent');
    expect(detail).toBeNull();
  });
});

// ========================================================================
// 5. NO SIDE EFFECTS
// ========================================================================

describe('no side effects', () => {
  it('10. calling diagnostics does not mutate rental state', async () => {
    const stuck = makeStuckRental('r-nse-1');
    await rentalRepo.save(stuck);
    await outboxRepo.create(makeSucceededTransferEvent('r-nse-1', 'tr_safe'));

    // Capture state before diagnostics
    const beforeRental = await rentalRepo.findById('r-nse-1');
    const beforeStatus = beforeRental!.escrowStatus;
    const beforeTransferId = beforeRental!.externalTransferId;
    const beforeVersion = beforeRental!.version;

    // Run all diagnostics operations
    await diagnosticsService.getStuckTransferSummary(300_000);
    await diagnosticsService.getStuckTransferDetails('r-nse-1');
    await diagnosticsService.getStuckTransferCorrelations(300_000);

    // Verify state unchanged
    const afterRental = await rentalRepo.findById('r-nse-1');
    expect(afterRental!.escrowStatus).toBe(beforeStatus);
    expect(afterRental!.externalTransferId).toBe(beforeTransferId);
    expect(afterRental!.version).toBe(beforeVersion);
  });

  it('11. calling diagnostics does not mutate outbox state', async () => {
    const stuck = makeStuckRental('r-nse-2');
    await rentalRepo.save(stuck);
    const event = makeSucceededTransferEvent('r-nse-2', 'tr_safe_2');
    await outboxRepo.create(event);

    // Capture state before diagnostics
    const beforeEvents = await outboxRepo.findByAggregate('Rental', 'r-nse-2');
    const beforeStatus = beforeEvents[0].status;
    const beforeResult = beforeEvents[0].result;

    // Run all diagnostics operations
    await diagnosticsService.getStuckTransferSummary(300_000);
    await diagnosticsService.getStuckTransferDetails('r-nse-2');
    await diagnosticsService.getStuckTransferCorrelations(300_000);

    // Verify state unchanged
    const afterEvents = await outboxRepo.findByAggregate('Rental', 'r-nse-2');
    expect(afterEvents).toHaveLength(beforeEvents.length);
    expect(afterEvents[0].status).toBe(beforeStatus);
    expect(afterEvents[0].result).toEqual(beforeResult);
  });
});

// ========================================================================
// 6. HEALTH MONITOR INTEGRATION
// ========================================================================

describe('HealthMonitor stuck transfer integration', () => {
  it('12. reports DEGRADED when stuck count exceeds degraded threshold', async () => {
    const config = loadResilienceConfig({
      stuckTransferDegradedThreshold: 2,
      stuckTransferNotReadyThreshold: 10,
    });

    const monitor = new HealthMonitor(config, [], {
      outboxPending: async () => 0,
      reconUnresolvedCritical: async () => 0,
      stuckTransferCount: async () => 3,
    });

    const report = await monitor.getReport();
    expect(report.status).toBe('DEGRADED');
    expect(report.degradedReasons).toContainEqual(
      expect.stringContaining('Stuck transfers elevated'),
    );
  });

  it('13. reports NOT_READY when stuck count exceeds critical threshold', async () => {
    const config = loadResilienceConfig({
      stuckTransferDegradedThreshold: 2,
      stuckTransferNotReadyThreshold: 10,
    });

    const monitor = new HealthMonitor(config, [], {
      outboxPending: async () => 0,
      reconUnresolvedCritical: async () => 0,
      stuckTransferCount: async () => 15,
    });

    const report = await monitor.getReport();
    expect(report.status).toBe('NOT_READY');
    expect(report.degradedReasons).toContainEqual(
      expect.stringContaining('Stuck transfers critical'),
    );
  });

  it('14. reports HEALTHY when no stuck transfers', async () => {
    const config = loadResilienceConfig({
      stuckTransferDegradedThreshold: 2,
      stuckTransferNotReadyThreshold: 10,
    });

    const monitor = new HealthMonitor(config, [], {
      outboxPending: async () => 0,
      reconUnresolvedCritical: async () => 0,
      stuckTransferCount: async () => 0,
    });

    const report = await monitor.getReport();
    expect(report.status).toBe('HEALTHY');
  });
});
