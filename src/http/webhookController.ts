import { Request, Response } from 'express';
import { MarketplacePaymentService } from '../application/services/MarketplacePaymentService';
import { SystemActor } from '../application/auth/Actor';
import { RentalRepository } from '../domain/interfaces/RentalRepository';
import { Rental } from '../domain/entities/Rental';
import { AuditLog } from '../application/audit/AuditLog';
import { DomainError } from '../domain/errors/DomainError';
import {
  PaymentProviderEvent,
  NormalizedEventType,
} from '../application/payments/PaymentProviderEvent';
import {
  WebhookEventValidator,
  PaymentEventType,
} from '../domain/services/WebhookEventValidator';
import { sendError } from './errorMapper';

/**
 * Processed webhook event store interface.
 * Backed by a persistent table to survive restarts.
 */
export interface ProcessedWebhookEventStore {
  has(eventId: string): Promise<boolean>;
  add(eventId: string, rentalId: string, eventType: string): Promise<void>;
}

/**
 * In-memory implementation for development/testing.
 */
export class InMemoryProcessedWebhookEventStore implements ProcessedWebhookEventStore {
  private readonly store = new Map<string, { rentalId: string; eventType: string; processedAt: Date }>();

  async has(eventId: string): Promise<boolean> {
    return this.store.has(eventId);
  }

  async add(eventId: string, rentalId: string, eventType: string): Promise<void> {
    this.store.set(eventId, { rentalId, eventType, processedAt: new Date() });
  }
}

/**
 * Function type for webhook verification + normalization.
 * Decouples the controller from the Stripe SDK.
 */
export type WebhookVerifier = (
  rawBody: string | Buffer,
  signature: string,
) => { event: PaymentProviderEvent; stripeEventId: string } | null;

/**
 * Map from NormalizedEventType to PaymentEventType for domain validation.
 */
function toPaymentEventType(type: NormalizedEventType): PaymentEventType | null {
  switch (type) {
    case NormalizedEventType.PAYMENT_AUTHORIZED:
      return PaymentEventType.PAYMENT_AUTHORIZED;
    case NormalizedEventType.PAYMENT_CAPTURED:
      return PaymentEventType.PAYMENT_CAPTURED;
    case NormalizedEventType.PAYMENT_FAILED:
      return PaymentEventType.PAYMENT_FAILED;
    case NormalizedEventType.PAYMENT_REFUNDED:
      return PaymentEventType.CHARGE_REFUNDED;
    case NormalizedEventType.DISPUTE_OPENED:
      return PaymentEventType.DISPUTE_OPENED;
    case NormalizedEventType.DISPUTE_CLOSED:
      return PaymentEventType.DISPUTE_CLOSED;
    default:
      return null;
  }
}

/**
 * HTTP controller for payment provider webhook callbacks.
 *
 * Design constraints:
 * - All handlers use SystemActor — webhooks are system-to-system
 * - Rental lookup is by externalPaymentIntentId
 * - Unknown event types are acknowledged, not rejected
 * - All domain guards remain active — the webhook cannot bypass FSM or auth
 * - No fund custody: we instruct the external provider, never hold principal
 *
 * Hardening layers (defense-in-depth):
 * 1. Signature verification — rejects unverified payloads at the gate
 * 2. Event ID dedup — rejects already-processed events (persistent store)
 * 3. WebhookEventValidator — pre-dispatch sequence/state validation
 * 4. Entity FSM — Rental.transitionTo() enforces VALID_TRANSITIONS
 * 5. MarketplacePaymentService — auth + terminal + regulatory guards
 * 6. Optimistic concurrency — repository save rejects stale writes
 */
export class WebhookController {
  private readonly paymentService: MarketplacePaymentService;
  private readonly rentalRepo: RentalRepository;
  private readonly auditLog: AuditLog;
  private readonly processedEvents: ProcessedWebhookEventStore;
  private readonly verifyWebhook: WebhookVerifier;

  constructor(deps: {
    paymentService: MarketplacePaymentService;
    rentalRepo: RentalRepository;
    auditLog: AuditLog;
    processedEvents: ProcessedWebhookEventStore;
    verifyWebhook: WebhookVerifier;
  }) {
    this.paymentService = deps.paymentService;
    this.rentalRepo = deps.rentalRepo;
    this.auditLog = deps.auditLog;
    this.processedEvents = deps.processedEvents;
    this.verifyWebhook = deps.verifyWebhook;
  }

  /**
   * POST /webhooks/stripe
   *
   * Processing pipeline:
   * 1. Verify signature and normalize event
   * 2. Event ID dedup (persistent)
   * 3. Resolve rental by external payment intent ID
   * 4. Pre-dispatch state validation (sequence + duplicate + regression)
   * 5. Dispatch to MarketplacePaymentService
   * 6. Persist rental state
   * 7. Record event as processed
   * 8. Audit success
   */
  async handleStripeEvent(req: Request, res: Response): Promise<void> {
    // 1. Verify signature and normalize
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      res.status(400).json({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Missing stripe-signature header' } });
      return;
    }

    let result: { event: PaymentProviderEvent; stripeEventId: string } | null;
    try {
      result = this.verifyWebhook(req.body, signature);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WEBHOOK_SIGNATURE_INVALID') {
        res.status(401).json({ error: { code: error.code, message: error.message } });
        return;
      }
      sendError(res, error);
      return;
    }

    // Unsupported but valid event — acknowledge without processing
    if (!result) {
      res.status(200).json({ received: true, processed: false, reason: 'unsupported_event_type' });
      return;
    }

    const { event, stripeEventId } = result;
    const actor: SystemActor = {
      kind: 'system',
      source: `stripe_webhook:${event.type}`,
    };

    // 2. Event ID dedup — persistent check
    const alreadyProcessed = await this.processedEvents.has(stripeEventId);
    if (alreadyProcessed) {
      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: event.externalPaymentIntentId,
        action: 'webhook_event_id_dedup',
        outcome: 'blocked',
        errorCode: 'DUPLICATE_PAYMENT_EVENT',
        errorMessage: `Event ${stripeEventId} already processed`,
        externalRef: stripeEventId,
      });
      res.status(200).json({ received: true, processed: false, reason: 'already_processed' });
      return;
    }

    // 3. Look up rental by payment intent ID
    const rental = await this.rentalRepo.findByExternalPaymentIntentId(
      event.externalPaymentIntentId,
    );

    if (!rental) {
      this.auditLog.record({
        actor,
        entityType: 'StripeEvent',
        entityId: stripeEventId,
        action: 'webhook_rental_not_found',
        outcome: 'blocked',
        errorMessage: `No rental found for payment intent: ${event.externalPaymentIntentId}`,
        externalRef: event.externalPaymentIntentId,
      });
      res.status(200).json({ received: true, processed: false, reason: 'rental_not_found' });
      return;
    }

    // 4. Map to domain event type and validate
    const paymentEventType = toPaymentEventType(event.type);
    if (!paymentEventType) {
      res.status(200).json({ received: true, processed: false, reason: 'unmapped_event_type' });
      return;
    }

    const beforeStatus = rental.escrowStatus;
    const beforeVersion = rental.version;
    const validation = WebhookEventValidator.validate(
      paymentEventType,
      rental.escrowStatus,
      rental.disputeOpen,
    );

    if (validation.outcome === 'duplicate') {
      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: rental.id,
        action: 'webhook_duplicate_delivery',
        outcome: 'blocked',
        beforeState: rental.escrowStatus,
        errorCode: 'DUPLICATE_PAYMENT_EVENT',
        errorMessage: validation.reason,
        externalRef: stripeEventId,
      });
      await this.processedEvents.add(stripeEventId, rental.id, event.type);
      res.status(200).json({ received: true, processed: false, reason: 'duplicate_event' });
      return;
    }

    if (validation.outcome === 'rejected') {
      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: rental.id,
        action: 'webhook_sequence_rejected',
        outcome: 'blocked',
        beforeState: rental.escrowStatus,
        errorCode: validation.code,
        errorMessage: validation.reason,
        externalRef: stripeEventId,
      });
      res.status(409).json({
        error: { code: validation.code, message: validation.reason },
      });
      return;
    }

    // 5. Dispatch to MarketplacePaymentService
    try {
      await this.dispatchEvent(actor, paymentEventType, rental);
    } catch (error) {
      if (error instanceof DomainError) {
        this.auditLog.record({
          actor,
          entityType: 'Rental',
          entityId: rental.id,
          action: `webhook_dispatch_rejected:${event.type}`,
          outcome: 'blocked',
          beforeState: beforeStatus,
          errorCode: error.code,
          errorMessage: error.message,
          externalRef: stripeEventId,
        });
      }
      sendError(res, error);
      return;
    }

    // 6. Persist updated rental state (only if the handler mutated the entity)
    const entityMutated = rental.version !== beforeVersion;
    if (entityMutated) {
      try {
        await this.rentalRepo.save(rental);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'VERSION_CONFLICT') {
          this.auditLog.record({
            actor,
            entityType: 'Rental',
            entityId: rental.id,
            action: 'webhook_save_version_conflict',
            outcome: 'error',
            beforeState: beforeStatus,
            afterState: rental.escrowStatus,
            errorCode: error.code,
            errorMessage: error.message,
            externalRef: stripeEventId,
          });
          res.status(409).json({
            error: { code: 'VERSION_CONFLICT', message: 'Concurrent modification detected; retry the event' },
          });
          return;
        }
        throw error;
      }
    }

    // 7. Record event as processed (after successful save)
    await this.processedEvents.add(stripeEventId, rental.id, event.type);

    // 8. Audit: webhook successfully processed
    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: `webhook_processed:${event.type}`,
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: rental.escrowStatus,
      externalRef: stripeEventId,
    });

    res.status(200).json({ received: true, processed: true });
  }

  /**
   * Dispatch a validated event to the appropriate MarketplacePaymentService handler.
   * All webhook-driven handlers are PASSIVE — no provider API calls.
   */
  private async dispatchEvent(
    actor: SystemActor,
    eventType: PaymentEventType,
    rental: Rental,
  ): Promise<void> {
    switch (eventType) {
      case PaymentEventType.PAYMENT_AUTHORIZED:
        await this.paymentService.handlePaymentAuthorized(actor, rental);
        break;
      case PaymentEventType.PAYMENT_CAPTURED:
        await this.paymentService.handlePaymentCaptured(actor, rental);
        break;
      case PaymentEventType.PAYMENT_FAILED:
        await this.paymentService.handlePaymentFailed(actor, rental);
        break;
      case PaymentEventType.CHARGE_REFUNDED:
        await this.paymentService.handlePaymentRefunded(actor, rental);
        break;
      case PaymentEventType.DISPUTE_OPENED:
        await this.paymentService.handleDisputeOpened(actor, rental);
        break;
      case PaymentEventType.DISPUTE_CLOSED:
        await this.paymentService.handleDisputeResolved(actor, rental);
        break;
      default: {
        const _exhaustive: never = eventType;
        throw new DomainError(
          `Unhandled payment event type: ${_exhaustive}`,
          'INVALID_PAYMENT_TRANSITION',
        );
      }
    }
  }
}
