import Stripe from 'stripe';
import { DomainError } from '../../domain/errors/DomainError';
import {
  PaymentProviderEvent,
  NormalizedEventType,
} from '../../application/payments/PaymentProviderEvent';

/**
 * Stripe webhook signature verification and event normalization.
 *
 * This module sits at the infrastructure boundary. It:
 * 1. Verifies the Stripe-Signature header against the webhook secret
 * 2. Parses the raw JSON body into a Stripe event
 * 3. Normalizes the Stripe event into a PaymentProviderEvent
 *
 * No Stripe SDK types escape this module — only PaymentProviderEvent
 * crosses into application/domain code.
 *
 * Stripe event types handled:
 *   checkout.session.completed          → PAYMENT_AUTHORIZED
 *   payment_intent.amount_capturable_updated → PAYMENT_AUTHORIZED (backup)
 *   payment_intent.succeeded            → PAYMENT_CAPTURED
 *   charge.refunded                     → PAYMENT_REFUNDED
 *   charge.dispute.created              → DISPUTE_OPENED
 *   charge.dispute.closed               → DISPUTE_CLOSED
 */

const SUPPORTED_STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
]);

/**
 * Map from real Stripe event type to our normalized type.
 */
function mapStripeEventType(stripeType: string): NormalizedEventType | null {
  switch (stripeType) {
    case 'checkout.session.completed':
    case 'payment_intent.amount_capturable_updated':
      return NormalizedEventType.PAYMENT_AUTHORIZED;
    case 'payment_intent.succeeded':
      return NormalizedEventType.PAYMENT_CAPTURED;
    case 'charge.refunded':
      return NormalizedEventType.PAYMENT_REFUNDED;
    case 'charge.dispute.created':
      return NormalizedEventType.DISPUTE_OPENED;
    case 'charge.dispute.closed':
      return NormalizedEventType.DISPUTE_CLOSED;
    default:
      return null;
  }
}

export class StripeWebhookHandler {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(stripe: Stripe, webhookSecret: string) {
    this.stripe = stripe;
    this.webhookSecret = webhookSecret;
  }

  /**
   * Verify webhook signature and parse the event.
   * Rejects unverified payloads with WEBHOOK_SIGNATURE_INVALID.
   */
  verifyAndParse(rawBody: string | Buffer, signature: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      throw new DomainError(
        `Webhook signature verification failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'WEBHOOK_SIGNATURE_INVALID',
      );
    }
  }

  /**
   * Check if a Stripe event type is one we handle.
   */
  isSupportedEvent(eventType: string): boolean {
    return SUPPORTED_STRIPE_EVENTS.has(eventType);
  }

  /**
   * Normalize a verified Stripe event into a provider-neutral PaymentProviderEvent.
   *
   * Extracts the payment intent ID from the event regardless of event type,
   * ensuring consistent rental lookup via findByExternalPaymentIntentId.
   *
   * Returns null if the event type is not supported.
   */
  normalize(event: Stripe.Event): PaymentProviderEvent | null {
    const normalizedType = mapStripeEventType(event.type);
    if (!normalizedType) return null;

    const obj = event.data.object as unknown as Record<string, unknown>;
    const paymentIntentId = this.extractPaymentIntentId(event.type, obj);

    if (!paymentIntentId) {
      throw new DomainError(
        `Cannot extract payment intent ID from ${event.type} event`,
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    return {
      externalEventId: event.id,
      type: normalizedType,
      externalPaymentIntentId: paymentIntentId,
      externalCheckoutSessionId: this.extractCheckoutSessionId(event.type, obj),
      connectedAccountId: typeof obj.destination === 'string' ? obj.destination : null,
      refundAmountCents: this.extractRefundAmount(event.type, obj),
      disputeWonByPlatform: this.extractDisputeOutcome(event.type, obj),
      rawReferenceId: typeof obj.id === 'string' ? obj.id : event.id,
      occurredAt: new Date(event.created * 1000),
    };
  }

  /**
   * Convenience: verify, check support, and normalize in one call.
   * Returns null for unsupported (but valid) events.
   */
  processWebhook(
    rawBody: string | Buffer,
    signature: string,
  ): { event: PaymentProviderEvent; stripeEventId: string } | null {
    const stripeEvent = this.verifyAndParse(rawBody, signature);

    if (!this.isSupportedEvent(stripeEvent.type)) {
      return null;
    }

    const normalized = this.normalize(stripeEvent);
    if (!normalized) return null;

    return { event: normalized, stripeEventId: stripeEvent.id };
  }

  /**
   * Extract payment intent ID from event object.
   * Different Stripe event types store the PI ID in different fields.
   */
  private extractPaymentIntentId(
    eventType: string,
    obj: Record<string, unknown>,
  ): string | null {
    switch (eventType) {
      case 'checkout.session.completed': {
        // Session object: payment_intent can be string or object
        const pi = obj.payment_intent;
        if (typeof pi === 'string') return pi;
        if (pi && typeof pi === 'object' && 'id' in pi) {
          return (pi as { id: string }).id;
        }
        return null;
      }
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.succeeded': {
        // Object IS the payment intent
        return typeof obj.id === 'string' ? obj.id : null;
      }
      case 'charge.refunded': {
        // Charge object: payment_intent field
        const pi = obj.payment_intent;
        if (typeof pi === 'string') return pi;
        if (pi && typeof pi === 'object' && 'id' in pi) {
          return (pi as { id: string }).id;
        }
        return null;
      }
      case 'charge.dispute.created':
      case 'charge.dispute.closed': {
        // Dispute object: payment_intent field
        const pi = obj.payment_intent;
        if (typeof pi === 'string') return pi;
        if (pi && typeof pi === 'object' && 'id' in pi) {
          return (pi as { id: string }).id;
        }
        return null;
      }
      default:
        return null;
    }
  }

  private extractCheckoutSessionId(
    eventType: string,
    obj: Record<string, unknown>,
  ): string | null {
    if (eventType === 'checkout.session.completed' && typeof obj.id === 'string') {
      return obj.id;
    }
    return null;
  }

  private extractRefundAmount(
    eventType: string,
    obj: Record<string, unknown>,
  ): number | null {
    if (eventType === 'charge.refunded' && typeof obj.amount_refunded === 'number') {
      return obj.amount_refunded;
    }
    return null;
  }

  private extractDisputeOutcome(
    eventType: string,
    obj: Record<string, unknown>,
  ): boolean | null {
    if (eventType === 'charge.dispute.closed') {
      // Stripe dispute status 'won' means the platform won
      return obj.status === 'won';
    }
    return null;
  }
}
