import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { StripeWebhookHandler } from '../../../src/infrastructure/payments/StripeWebhookHandler';
import { NormalizedEventType } from '../../../src/application/payments/PaymentProviderEvent';

/**
 * Tests for StripeWebhookHandler normalization and event parsing.
 *
 * These tests do NOT call real Stripe APIs. They test:
 * 1. Event normalization from raw Stripe event shapes to PaymentProviderEvent
 * 2. Correct extraction of payment intent IDs from different event types
 * 3. Signature verification failure behavior
 * 4. Unsupported event type handling
 */

const TEST_WEBHOOK_SECRET = 'whsec_test_secret';

function makeStripe(): Stripe {
  return new Stripe('sk_test_fake', { apiVersion: '2026-02-25.clover' });
}

function makeHandler(): StripeWebhookHandler {
  return new StripeWebhookHandler(makeStripe(), TEST_WEBHOOK_SECRET);
}

/**
 * Helper to create a raw Stripe event object (bypassing signature verification).
 * For normalization tests, we call normalize() directly with a pre-built event.
 */
function fakeStripeEvent(overrides: Partial<Stripe.Event> & {
  type: string;
  dataObject: Record<string, unknown>;
}): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_test_123',
    object: 'event',
    type: overrides.type,
    api_version: '2026-02-25.clover',
    created: overrides.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: overrides.dataObject as unknown as Stripe.Event.Data.Object,
    },
  } as Stripe.Event;
}

describe('StripeWebhookHandler', () => {
  describe('normalize', () => {
    it('normalizes checkout.session.completed to PAYMENT_AUTHORIZED', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'checkout.session.completed',
        dataObject: {
          id: 'cs_test_session',
          payment_intent: 'pi_test_intent',
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(NormalizedEventType.PAYMENT_AUTHORIZED);
      expect(result!.externalPaymentIntentId).toBe('pi_test_intent');
      expect(result!.externalCheckoutSessionId).toBe('cs_test_session');
      expect(result!.externalEventId).toBe('evt_test_123');
    });

    it('normalizes payment_intent.succeeded to PAYMENT_CAPTURED', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'payment_intent.succeeded',
        dataObject: {
          id: 'pi_test_intent',
          status: 'succeeded',
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(NormalizedEventType.PAYMENT_CAPTURED);
      expect(result!.externalPaymentIntentId).toBe('pi_test_intent');
      expect(result!.externalCheckoutSessionId).toBeNull();
    });

    it('normalizes charge.refunded to PAYMENT_REFUNDED with amount', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'charge.refunded',
        dataObject: {
          id: 'ch_test_charge',
          payment_intent: 'pi_test_intent',
          amount_refunded: 50000,
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(NormalizedEventType.PAYMENT_REFUNDED);
      expect(result!.externalPaymentIntentId).toBe('pi_test_intent');
      expect(result!.refundAmountCents).toBe(50000);
      expect(result!.rawReferenceId).toBe('ch_test_charge');
    });

    it('normalizes charge.dispute.created to DISPUTE_OPENED', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'charge.dispute.created',
        dataObject: {
          id: 'dp_test_dispute',
          payment_intent: 'pi_test_intent',
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(NormalizedEventType.DISPUTE_OPENED);
      expect(result!.externalPaymentIntentId).toBe('pi_test_intent');
    });

    it('normalizes charge.dispute.closed with won status', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'charge.dispute.closed',
        dataObject: {
          id: 'dp_test_dispute',
          payment_intent: 'pi_test_intent',
          status: 'won',
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(NormalizedEventType.DISPUTE_CLOSED);
      expect(result!.disputeWonByPlatform).toBe(true);
    });

    it('normalizes charge.dispute.closed with lost status', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'charge.dispute.closed',
        dataObject: {
          id: 'dp_test_dispute',
          payment_intent: 'pi_test_intent',
          status: 'lost',
        },
      });

      const result = handler.normalize(event);

      expect(result!.disputeWonByPlatform).toBe(false);
    });

    it('returns null for unsupported event types', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'customer.subscription.created',
        dataObject: { id: 'sub_test' },
      });

      const result = handler.normalize(event);
      expect(result).toBeNull();
    });

    it('normalizes payment_intent.amount_capturable_updated to PAYMENT_AUTHORIZED', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        type: 'payment_intent.amount_capturable_updated',
        dataObject: {
          id: 'pi_test_intent',
          amount_capturable: 50000,
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.type).toBe(NormalizedEventType.PAYMENT_AUTHORIZED);
      expect(result!.externalPaymentIntentId).toBe('pi_test_intent');
    });
  });

  describe('isSupportedEvent', () => {
    it('returns true for all supported event types', () => {
      const handler = makeHandler();
      expect(handler.isSupportedEvent('checkout.session.completed')).toBe(true);
      expect(handler.isSupportedEvent('payment_intent.amount_capturable_updated')).toBe(true);
      expect(handler.isSupportedEvent('payment_intent.succeeded')).toBe(true);
      expect(handler.isSupportedEvent('charge.refunded')).toBe(true);
      expect(handler.isSupportedEvent('charge.dispute.created')).toBe(true);
      expect(handler.isSupportedEvent('charge.dispute.closed')).toBe(true);
    });

    it('returns false for unsupported event types', () => {
      const handler = makeHandler();
      expect(handler.isSupportedEvent('payment_method.attached')).toBe(false);
      expect(handler.isSupportedEvent('customer.created')).toBe(false);
    });
  });

  describe('verifyAndParse', () => {
    it('rejects invalid signature with WEBHOOK_SIGNATURE_INVALID', () => {
      const handler = makeHandler();
      expect(() => {
        handler.verifyAndParse('{"id":"evt_test"}', 'invalid_signature');
      }).toThrow('Webhook signature verification failed');
    });

    it('rejects empty body', () => {
      const handler = makeHandler();
      expect(() => {
        handler.verifyAndParse('', 'some_signature');
      }).toThrow();
    });
  });

  describe('metadata schema', () => {
    it('checkout session normalized event includes correct fields', () => {
      const handler = makeHandler();
      const event = fakeStripeEvent({
        id: 'evt_metadata_test',
        type: 'checkout.session.completed',
        created: 1700000000,
        dataObject: {
          id: 'cs_metadata_session',
          payment_intent: 'pi_metadata_intent',
          destination: 'acct_connected_123',
        },
      });

      const result = handler.normalize(event);

      expect(result).not.toBeNull();
      expect(result!.externalEventId).toBe('evt_metadata_test');
      expect(result!.externalPaymentIntentId).toBe('pi_metadata_intent');
      expect(result!.externalCheckoutSessionId).toBe('cs_metadata_session');
      expect(result!.connectedAccountId).toBe('acct_connected_123');
      expect(result!.occurredAt).toEqual(new Date(1700000000 * 1000));
      // No custody-related naming in the normalized event
      expect(Object.keys(result!)).not.toContain('wallet');
      expect(Object.keys(result!)).not.toContain('balance');
      expect(Object.keys(result!)).not.toContain('payout');
    });
  });
});
