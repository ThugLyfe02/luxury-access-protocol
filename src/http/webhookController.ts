import { Request, Response } from 'express';
import { MarketplacePaymentService } from '../application/services/MarketplacePaymentService';
import { SystemActor } from '../application/auth/Actor';
import { RentalRepository } from '../domain/interfaces/RentalRepository';
import { validateStripeWebhookBody } from './validation';
import { sendError } from './errorMapper';

/**
 * Supported Stripe webhook event types.
 *
 * Only events that map to reconstructed MarketplacePaymentService
 * methods are accepted. Unknown event types are acknowledged with
 * 200 but not processed (standard Stripe webhook best practice).
 */
const SUPPORTED_EVENT_TYPES = new Set([
  'payment_intent.authorized',
  'payment_intent.captured',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
]);

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
 * Known gap: Stripe signature verification (webhook secret + stripe-signature
 * header) is not implemented. In production this MUST be added before
 * this endpoint is exposed to the internet. Documented for next phase.
 */
export class WebhookController {
  private readonly paymentService: MarketplacePaymentService;
  private readonly rentalRepo: RentalRepository;
  /**
   * Tracks Stripe event IDs that have been successfully processed.
   * This is a first-line dedup filter — if a retried webhook arrives
   * with an event ID we've already processed, we immediately return
   * 200 without touching the domain layer.
   *
   * In production, this would be backed by a persistent store (e.g.,
   * a processed_events table with a unique constraint on event_id).
   * The in-memory Set is sufficient for the current reconstruction stage.
   */
  private readonly processedEventIds = new Set<string>();

  constructor(deps: {
    paymentService: MarketplacePaymentService;
    rentalRepo: RentalRepository;
  }) {
    this.paymentService = deps.paymentService;
    this.rentalRepo = deps.rentalRepo;
  }

  /**
   * POST /webhooks/stripe
   *
   * Receives Stripe webhook events and delegates to the appropriate
   * MarketplacePaymentService handler.
   *
   * Idempotency: Stripe may retry webhook delivery. The domain FSM
   * rejects duplicate transitions (e.g., marking AUTHORIZED when
   * already AUTHORIZED throws INVALID_ESCROW_TRANSITION). The controller
   * catches this and returns 200 to prevent Stripe from retrying
   * indefinitely. This is a deliberate idempotency-aware design:
   * the domain enforces "at-most-once" semantics, and the HTTP layer
   * translates FSM rejection of duplicate events into success acks.
   */
  async handleStripeEvent(req: Request, res: Response): Promise<void> {
    try {
      // 1. Validate event shape
      const validated = validateStripeWebhookBody(req.body);
      if (!validated.valid) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: validated.errors } });
        return;
      }

      const event = validated.value;

      // 2. Event ID dedup — if we've already processed this event, ack immediately
      if (this.processedEventIds.has(event.id)) {
        res.status(200).json({ received: true, processed: false, reason: 'already_processed' });
        return;
      }

      // 3. Acknowledge unsupported event types without error
      if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
        res.status(200).json({ received: true, processed: false });
        return;
      }

      // 4. Look up the rental by the Stripe object ID (payment intent / charge ID)
      const stripeObjectId = event.data.object.id;
      const rental = await this.rentalRepo.findByExternalPaymentIntentId(stripeObjectId);

      if (!rental) {
        // No matching rental — could be an event for a different product
        // or a stale webhook. Acknowledge to prevent retries.
        res.status(200).json({ received: true, processed: false });
        return;
      }

      // 5. Build system actor for webhook context
      const actor: SystemActor = {
        kind: 'system',
        source: `stripe_webhook:${event.type}`,
      };

      // 6. Dispatch to the appropriate handler
      await this.dispatchEvent(actor, event.type, rental);

      // 7. Persist updated rental state
      await this.rentalRepo.save(rental);

      // 8. Record event as processed (after successful save)
      this.processedEventIds.add(event.id);

      res.status(200).json({ received: true, processed: true });
    } catch (error) {
      // Idempotency handling: if the domain rejects a transition because
      // the rental is already in the target state (duplicate webhook),
      // we return 200 to stop Stripe from retrying.
      if (this.isDuplicateTransitionError(error)) {
        res.status(200).json({ received: true, processed: false, reason: 'duplicate_event' });
        return;
      }

      sendError(res, error);
    }
  }

  private async dispatchEvent(
    actor: SystemActor,
    eventType: string,
    rental: import('../domain/entities/Rental').Rental,
  ): Promise<void> {
    switch (eventType) {
      case 'payment_intent.authorized':
        await this.paymentService.handlePaymentAuthorized(actor, rental);
        break;
      case 'payment_intent.captured':
        await this.paymentService.handlePaymentCaptured(actor, rental);
        break;
      case 'charge.refunded':
        await this.paymentService.handlePaymentRefunded(actor, rental);
        break;
      case 'charge.dispute.created':
        await this.paymentService.handleDisputeOpened(actor, rental);
        break;
      case 'charge.dispute.closed':
        await this.paymentService.handleDisputeResolved(actor, rental);
        break;
    }
  }

  /**
   * Detect whether an error represents a duplicate state transition.
   * These are expected under webhook retry scenarios and should be
   * acknowledged as success to prevent infinite retries.
   */
  private isDuplicateTransitionError(error: unknown): boolean {
    if (
      error !== null &&
      error !== undefined &&
      typeof error === 'object' &&
      'code' in error
    ) {
      const code = (error as { code: string }).code;
      return (
        code === 'INVALID_ESCROW_TRANSITION' ||
        code === 'INVALID_STATE_TRANSITION'
      );
    }
    return false;
  }
}
