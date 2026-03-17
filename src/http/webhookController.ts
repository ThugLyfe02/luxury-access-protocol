import { Request, Response } from 'express';
import { MarketplacePaymentService } from '../application/services/MarketplacePaymentService';
import { SystemActor } from '../application/auth/Actor';
import { RentalRepository } from '../domain/interfaces/RentalRepository';
import { Rental } from '../domain/entities/Rental';
import { AuditLog } from '../application/audit/AuditLog';
import { DomainError } from '../domain/errors/DomainError';
import {
  WebhookEventValidator,
  PaymentEventType,
} from '../domain/services/WebhookEventValidator';
import { validateStripeWebhookBody } from './validation';
import { sendError } from './errorMapper';

/**
 * HTTP controller for Stripe webhook callbacks.
 *
 * Design constraints:
 * - All handlers use SystemActor — webhooks are system-to-system
 * - Rental lookup is by externalPaymentIntentId (the Stripe object ID)
 * - Unknown event types are acknowledged, not rejected
 * - All domain guards remain active — the webhook cannot bypass FSM or auth
 * - No fund custody: we instruct the external provider, never hold principal
 *
 * Hardening layers (defense-in-depth):
 * 1. Event ID dedup — rejects already-processed events at the gate
 * 2. WebhookEventValidator — pre-dispatch sequence/state validation
 *    Distinguishes duplicate delivery from out-of-order from regression
 * 3. Entity FSM — Rental.transitionTo() enforces VALID_TRANSITIONS
 * 4. MarketplacePaymentService — auth + terminal + regulatory guards
 * 5. Optimistic concurrency — repository save rejects stale writes
 *
 * Known gap: Stripe signature verification (webhook secret + stripe-signature
 * header) is not implemented. In production this MUST be added before
 * this endpoint is exposed to the internet.
 */
export class WebhookController {
  private readonly paymentService: MarketplacePaymentService;
  private readonly rentalRepo: RentalRepository;

  /**
   * Tracks Stripe event IDs that have been successfully processed,
   * along with the rental ID they affected.
   *
   * Keyed by Stripe event ID → { rentalId, eventType, processedAt }.
   *
   * In production, this would be backed by a persistent store (e.g.,
   * a processed_events table with a unique constraint on event_id).
   * The in-memory Map is sufficient for the current reconstruction stage.
   */
  private readonly processedEvents = new Map<
    string,
    { rentalId: string; eventType: string; processedAt: Date }
  >();

  private readonly auditLog: AuditLog;

  constructor(deps: {
    paymentService: MarketplacePaymentService;
    rentalRepo: RentalRepository;
    auditLog: AuditLog;
  }) {
    this.paymentService = deps.paymentService;
    this.rentalRepo = deps.rentalRepo;
    this.auditLog = deps.auditLog;
  }

  /**
   * POST /webhooks/stripe
   *
   * Receives Stripe webhook events and delegates to the appropriate
   * MarketplacePaymentService handler.
   *
   * Processing pipeline:
   * 1. Validate event shape (transport boundary)
   * 2. Event ID dedup (first-line replay filter)
   * 3. Reject unsupported event types
   * 4. Resolve rental by external payment ID
   * 5. Pre-dispatch state validation (sequence + duplicate + regression)
   * 6. Dispatch to MarketplacePaymentService
   * 7. Persist rental state
   * 8. Record event as processed
   * 9. Audit success
   *
   * A retried or malicious webhook cannot put a rental into an
   * impossible state — every layer rejects invalid transitions
   * independently.
   */
  async handleStripeEvent(req: Request, res: Response): Promise<void> {
    // 1. Validate event shape
    const validated = validateStripeWebhookBody(req.body);
    if (!validated.valid) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: validated.errors } });
      return;
    }

    const event = validated.value;
    const actor: SystemActor = {
      kind: 'system',
      source: `stripe_webhook:${event.type}`,
    };

    // 2. Event ID dedup — already processed this exact event
    const priorProcessing = this.processedEvents.get(event.id);
    if (priorProcessing) {
      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: priorProcessing.rentalId,
        action: 'webhook_event_id_dedup',
        outcome: 'blocked',
        errorCode: 'DUPLICATE_REQUEST',
        errorMessage: `Event ${event.id} already processed for rental ${priorProcessing.rentalId} at ${priorProcessing.processedAt.toISOString()}`,
        externalRef: event.id,
      });
      res.status(200).json({ received: true, processed: false, reason: 'already_processed' });
      return;
    }

    // 3. Check if event type is supported
    if (!WebhookEventValidator.isSupportedEventType(event.type)) {
      this.auditLog.record({
        actor,
        entityType: 'StripeEvent',
        entityId: event.id,
        action: 'webhook_unsupported_event_type',
        outcome: 'blocked',
        errorMessage: `Unsupported event type: ${event.type}`,
        externalRef: event.id,
      });
      res.status(200).json({ received: true, processed: false, reason: 'unsupported_event_type' });
      return;
    }

    const eventType = event.type as PaymentEventType;
    const stripeObjectId = event.data.object.id;

    // 4. Look up the rental by the Stripe object ID
    const rental = await this.rentalRepo.findByExternalPaymentIntentId(stripeObjectId);

    if (!rental) {
      this.auditLog.record({
        actor,
        entityType: 'StripeEvent',
        entityId: event.id,
        action: 'webhook_rental_not_found',
        outcome: 'blocked',
        errorMessage: `No rental found for external payment ID: ${stripeObjectId}`,
        externalRef: stripeObjectId,
      });
      res.status(200).json({ received: true, processed: false, reason: 'rental_not_found' });
      return;
    }

    // 5. Pre-dispatch state validation
    const beforeStatus = rental.escrowStatus;
    const validation = WebhookEventValidator.validate(
      eventType,
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
        errorCode: 'DUPLICATE_REQUEST',
        errorMessage: validation.reason,
        externalRef: event.id,
      });
      // Mark as processed to prevent future retries from hitting validation again
      this.processedEvents.set(event.id, {
        rentalId: rental.id,
        eventType: event.type,
        processedAt: new Date(),
      });
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
        externalRef: event.id,
      });
      // Do NOT ack with 200 — this is a genuinely invalid event that
      // should not be silently swallowed. Return 409 Conflict so that
      // operational monitoring can detect sequence anomalies.
      res.status(409).json({
        error: {
          code: validation.code,
          message: validation.reason,
        },
      });
      return;
    }

    // 6. Dispatch to MarketplacePaymentService
    try {
      await this.dispatchEvent(actor, eventType, rental);
    } catch (error) {
      // Domain layer rejected the transition despite pre-validation passing.
      // This is a defense-in-depth catch — the entity FSM is the ultimate authority.
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
          externalRef: event.id,
        });
      }
      sendError(res, error);
      return;
    }

    // 7. Persist updated rental state
    try {
      await this.rentalRepo.save(rental);
    } catch (error) {
      // Version conflict = concurrent write. Do NOT mark as processed —
      // the event should be retried.
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
          externalRef: event.id,
        });
        res.status(409).json({
          error: { code: 'VERSION_CONFLICT', message: 'Concurrent modification detected; retry the event' },
        });
        return;
      }
      throw error;
    }

    // 8. Record event as processed (after successful save)
    this.processedEvents.set(event.id, {
      rentalId: rental.id,
      eventType: event.type,
      processedAt: new Date(),
    });

    // 9. Audit: webhook successfully processed
    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: `webhook_processed:${event.type}`,
      outcome: 'success',
      beforeState: beforeStatus,
      afterState: rental.escrowStatus,
      externalRef: event.id,
    });

    res.status(200).json({ received: true, processed: true });
  }

  /**
   * Dispatch a validated event to the appropriate MarketplacePaymentService handler.
   *
   * Uses the PaymentEventType enum — never raw strings. The switch is exhaustive
   * for all supported event types with a default guard that throws for unknown types
   * (which should be unreachable due to WebhookEventValidator.isSupportedEventType).
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
        // Exhaustive check — if this fires, a new PaymentEventType was
        // added without updating this switch.
        const _exhaustive: never = eventType;
        throw new DomainError(
          `Unhandled payment event type: ${_exhaustive}`,
          'INVALID_PAYMENT_TRANSITION',
        );
      }
    }
  }
}
