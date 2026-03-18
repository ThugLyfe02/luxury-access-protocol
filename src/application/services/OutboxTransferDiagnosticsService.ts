import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { OutboxRepository } from '../../domain/interfaces/OutboxRepository';
import { Rental } from '../../domain/entities/Rental';
import { OutboxEvent } from '../../domain/entities/OutboxEvent';

/**
 * Recovery classification for a stuck transfer-truth rental.
 */
export type RecoveryClassification =
  | 'will_recover_via_reconciliation'
  | 'needs_manual_intervention'
  | 'already_recoverable';

/**
 * Outbox correlation for a single stuck rental.
 */
export interface StuckTransferCorrelation {
  readonly rentalId: string;
  readonly renterId: string;
  readonly watchId: string;
  readonly escrowStatus: string;
  readonly returnConfirmed: boolean;
  readonly externalTransferId: string | null;
  readonly createdAt: string;
  readonly outboxEventCount: number;
  readonly latestOutboxStatus: string | null;
  readonly hasTransferIdInResult: boolean;
  readonly recoveryClassification: RecoveryClassification;
}

/**
 * Summary of all stuck transfer-truth rentals.
 */
export interface StuckTransferSummary {
  readonly totalStuck: number;
  readonly withSucceededTransferId: number;
  readonly withSucceededNoTransferId: number;
  readonly withOnlyFailedOrDeadLetter: number;
  readonly withNoOutboxEvents: number;
}

/**
 * Detailed view for a single stuck rental.
 */
export interface StuckTransferDetail {
  readonly rental: {
    readonly id: string;
    readonly renterId: string;
    readonly watchId: string;
    readonly rentalPrice: number;
    readonly escrowStatus: string;
    readonly returnConfirmed: boolean;
    readonly externalTransferId: string | null;
    readonly createdAt: string;
    readonly version: number;
  };
  readonly outboxEvents: ReadonlyArray<{
    readonly id: string;
    readonly topic: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly result: Record<string, unknown> | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
  readonly recoveryClassification: RecoveryClassification;
}

/**
 * Read-only diagnostics service for stuck transfer-truth rentals.
 *
 * A rental is "stuck" when:
 * - escrowStatus === EXTERNAL_PAYMENT_CAPTURED
 * - returnConfirmed === true
 * - externalTransferId === null
 * - older than configurable threshold
 *
 * This service NEVER mutates any state. All methods are pure reads.
 */
export class OutboxTransferDiagnosticsService {
  constructor(
    private readonly rentalRepo: RentalRepository,
    private readonly outboxRepo: OutboxRepository,
  ) {}

  /**
   * Get summary counts of stuck transfer-truth rentals.
   * Read-only — no mutations.
   */
  async getStuckTransferSummary(thresholdMs: number = 300_000): Promise<StuckTransferSummary> {
    const stuckRentals = await this.rentalRepo.findStuckTransferTruth(thresholdMs);

    let withSucceededTransferId = 0;
    let withSucceededNoTransferId = 0;
    let withOnlyFailedOrDeadLetter = 0;
    let withNoOutboxEvents = 0;

    for (const rental of stuckRentals) {
      const classification = await this.classifyRental(rental);
      switch (classification) {
        case 'will_recover_via_reconciliation':
        case 'already_recoverable':
          withSucceededTransferId++;
          break;
        case 'needs_manual_intervention': {
          const events = await this.getTransferEvents(rental.id);
          if (events.length === 0) {
            withNoOutboxEvents++;
          } else {
            const hasSucceeded = events.some(e => e.status === 'SUCCEEDED');
            if (hasSucceeded) {
              withSucceededNoTransferId++;
            } else {
              withOnlyFailedOrDeadLetter++;
            }
          }
          break;
        }
      }
    }

    return {
      totalStuck: stuckRentals.length,
      withSucceededTransferId,
      withSucceededNoTransferId,
      withOnlyFailedOrDeadLetter,
      withNoOutboxEvents,
    };
  }

  /**
   * Get detailed diagnostics for a specific stuck rental.
   * Read-only — no mutations.
   */
  async getStuckTransferDetails(rentalId: string): Promise<StuckTransferDetail | null> {
    const rental = await this.rentalRepo.findById(rentalId);
    if (!rental) return null;

    const events = await this.getTransferEvents(rentalId);
    const classification = await this.classifyRentalWithEvents(rental, events);

    return {
      rental: {
        id: rental.id,
        renterId: rental.renterId,
        watchId: rental.watchId,
        rentalPrice: rental.rentalPrice,
        escrowStatus: rental.escrowStatus,
        returnConfirmed: rental.returnConfirmed,
        externalTransferId: rental.externalTransferId,
        createdAt: rental.createdAt.toISOString(),
        version: rental.version,
      },
      outboxEvents: events.map(e => ({
        id: e.id,
        topic: e.topic,
        status: e.status,
        attemptCount: e.attemptCount,
        result: e.result as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      })),
      recoveryClassification: classification,
    };
  }

  /**
   * Get correlations for all stuck rentals.
   * Read-only — no mutations.
   */
  async getStuckTransferCorrelations(thresholdMs: number = 300_000): Promise<StuckTransferCorrelation[]> {
    const stuckRentals = await this.rentalRepo.findStuckTransferTruth(thresholdMs);
    const correlations: StuckTransferCorrelation[] = [];

    for (const rental of stuckRentals) {
      const events = await this.getTransferEvents(rental.id);
      const latestEvent = events.length > 0 ? events[events.length - 1] : null;
      const hasTransferIdInResult = events.some(
        e => e.status === 'SUCCEEDED' && e.result && typeof (e.result as Record<string, unknown>).transferId === 'string',
      );
      const classification = await this.classifyRentalWithEvents(rental, events);

      correlations.push({
        rentalId: rental.id,
        renterId: rental.renterId,
        watchId: rental.watchId,
        escrowStatus: rental.escrowStatus,
        returnConfirmed: rental.returnConfirmed,
        externalTransferId: rental.externalTransferId,
        createdAt: rental.createdAt.toISOString(),
        outboxEventCount: events.length,
        latestOutboxStatus: latestEvent?.status ?? null,
        hasTransferIdInResult,
        recoveryClassification: classification,
      });
    }

    return correlations;
  }

  /**
   * Fetch transfer-related outbox events for a rental.
   * Read-only — no mutations.
   */
  private async getTransferEvents(rentalId: string): Promise<OutboxEvent[]> {
    const allEvents = await this.outboxRepo.findByAggregate('Rental', rentalId);
    return allEvents.filter(e => e.topic === 'payment.transfer_to_owner');
  }

  private async classifyRental(rental: Rental): Promise<RecoveryClassification> {
    const events = await this.getTransferEvents(rental.id);
    return this.classifyRentalWithEvents(rental, events);
  }

  private async classifyRentalWithEvents(rental: Rental, events: OutboxEvent[]): Promise<RecoveryClassification> {
    // If rental already has a transferId, it's already recoverable
    if (rental.externalTransferId) {
      return 'already_recoverable';
    }

    // Check if any SUCCEEDED event has a valid transferId
    const hasRecoverableTransferId = events.some(
      e =>
        e.status === 'SUCCEEDED' &&
        e.result &&
        typeof (e.result as Record<string, unknown>).transferId === 'string' &&
        ((e.result as Record<string, unknown>).transferId as string).length > 0,
    );

    if (hasRecoverableTransferId) {
      return 'will_recover_via_reconciliation';
    }

    return 'needs_manual_intervention';
  }
}
