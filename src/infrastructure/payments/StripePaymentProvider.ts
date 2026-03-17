import Stripe from 'stripe';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { DomainError } from '../../domain/errors/DomainError';
import { StripeConfig } from './stripeConfig';

/**
 * Real Stripe Connect payment provider.
 *
 * Architecture: Separate Charges and Transfers.
 *
 * Why this model:
 * - The platform creates a direct charge on the platform's Stripe account.
 * - Stripe captures funds from the renter into the platform's Stripe balance.
 * - After deterministic business events (return confirmed, no disputes),
 *   the platform creates a Transfer to the owner's Connected Account.
 * - The platform fee is the difference: charge amount minus transfer amount.
 *
 * This model is chosen because:
 * 1. Funds are NOT immediately routed to the owner — release is deterministic.
 * 2. The platform never holds funds in an internal system — Stripe holds them.
 * 3. Destination charges would auto-route funds, removing platform control
 *    over the release timing, which violates the "release only after return" rule.
 * 4. The Stripe balance is Stripe's custody, not the platform's internal ledger.
 *
 * Anti-custody guarantees:
 * - No internal wallet, balance, or user-credit system exists.
 * - The only release mechanism is transferToConnectedAccount via Stripe API.
 * - No discretionary release path — all gates are enforced in MarketplacePaymentService.
 *
 * Metadata schema (on all Stripe objects):
 *   rentalId            — internal rental entity ID
 *   renterId            — renter user ID
 *   watchId             — watch entity ID
 *   ownerId             — watch owner user ID
 *   internalEnvironment — deployment environment tag
 *   flowVersion         — integration version for forward compatibility
 */
export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly config: StripeConfig;
  private readonly environment: string;

  constructor(config: StripeConfig) {
    this.config = config;
    this.environment = process.env.NODE_ENV ?? 'development';
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2026-02-25.clover',
      typescript: true,
    });
  }

  async createConnectedAccount(params: {
    ownerId: string;
    email: string;
    country: string;
  }): Promise<{ connectedAccountId: string }> {
    try {
      const account = await this.stripe.accounts.create({
        type: 'express',
        country: params.country || this.config.connectCountry,
        email: params.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          ownerId: params.ownerId,
          internalEnvironment: this.environment,
          flowVersion: '1',
        },
      });

      return { connectedAccountId: account.id };
    } catch (error) {
      throw this.wrapStripeError(error, 'Failed to create connected account');
    }
  }

  async createOnboardingLink(params: {
    connectedAccountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }> {
    try {
      const link = await this.stripe.accountLinks.create({
        account: params.connectedAccountId,
        return_url: params.returnUrl,
        refresh_url: params.refreshUrl,
        type: 'account_onboarding',
      });

      return { url: link.url };
    } catch (error) {
      throw this.wrapStripeError(error, 'Failed to create onboarding link');
    }
  }

  /**
   * Create a Checkout Session for a renter.
   *
   * Uses capture_method: 'manual' so that the payment is authorized
   * but NOT captured. Capture happens only after deterministic business
   * events (e.g., watch delivery confirmed). This prevents the platform
   * from capturing funds before the rental obligation is established.
   *
   * The platform fee is NOT applied here — it is computed at transfer
   * time as the difference between the charge and the owner's share.
   */
  async createCheckoutSession(params: {
    rentalId: string;
    renterId: string;
    watchId: string;
    ownerId: string;
    amount: number;
    currency: string;
  }): Promise<{ sessionId: string; paymentIntentId: string }> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: params.currency,
              product_data: {
                name: `Luxury Watch Rental — ${params.rentalId}`,
                metadata: {
                  rentalId: params.rentalId,
                  watchId: params.watchId,
                },
              },
              unit_amount: Math.round(params.amount * 100), // dollars to cents
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          capture_method: 'manual',
          metadata: {
            rentalId: params.rentalId,
            renterId: params.renterId,
            watchId: params.watchId,
            ownerId: params.ownerId,
            internalEnvironment: this.environment,
            flowVersion: '1',
          },
        },
        metadata: {
          rentalId: params.rentalId,
          renterId: params.renterId,
          watchId: params.watchId,
          ownerId: params.ownerId,
          internalEnvironment: this.environment,
          flowVersion: '1',
        },
        success_url: this.config.successUrl,
        cancel_url: this.config.cancelUrl,
      });

      // With mode: 'payment' and no deferred creation, the session always
      // includes a payment_intent. If it doesn't, the configuration is wrong.
      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;

      if (!paymentIntentId) {
        throw new DomainError(
          'Checkout session created without a payment intent — configuration error',
          'PAYMENT_PROVIDER_UNAVAILABLE',
        );
      }

      return {
        sessionId: session.id,
        paymentIntentId,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw this.wrapStripeError(error, 'Failed to create checkout session');
    }
  }

  async capturePayment(paymentIntentId: string): Promise<{ captured: boolean }> {
    try {
      const pi = await this.stripe.paymentIntents.capture(paymentIntentId);
      return { captured: pi.status === 'succeeded' };
    } catch (error) {
      throw this.wrapStripeError(error, 'Failed to capture payment');
    }
  }

  async refundPayment(paymentIntentId: string): Promise<{ refunded: boolean }> {
    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: paymentIntentId,
      });
      return { refunded: refund.status === 'succeeded' || refund.status === 'pending' };
    } catch (error) {
      throw this.wrapStripeError(error, 'Failed to refund payment');
    }
  }

  /**
   * Transfer the owner's share to their connected account.
   *
   * This is the ONLY mechanism for an owner to receive funds.
   * The platform fee = charge amount - transfer amount.
   * No internal ledger or balance bookkeeping exists.
   *
   * Uses idempotency_key based on rentalId to prevent duplicate transfers
   * if this method is retried after a transient failure.
   */
  async transferToConnectedAccount(params: {
    amount: number;
    connectedAccountId: string;
    rentalId: string;
  }): Promise<{ transferId: string }> {
    try {
      const transfer = await this.stripe.transfers.create(
        {
          amount: Math.round(params.amount * 100), // dollars to cents
          currency: 'usd',
          destination: params.connectedAccountId,
          metadata: {
            rentalId: params.rentalId,
            internalEnvironment: this.environment,
            flowVersion: '1',
          },
        },
        {
          idempotencyKey: `transfer_${params.rentalId}`,
        },
      );

      return { transferId: transfer.id };
    } catch (error) {
      throw this.wrapStripeError(error, 'Failed to transfer to connected account');
    }
  }

  /**
   * Access the underlying Stripe instance for webhook signature
   * verification. Only used by StripeWebhookHandler — never exposed
   * beyond the infrastructure layer.
   */
  getStripeInstance(): Stripe {
    return this.stripe;
  }

  /**
   * Translate Stripe SDK errors into DomainErrors.
   * Never leaks raw Stripe exceptions across layer boundaries.
   */
  private wrapStripeError(error: unknown, context: string): DomainError {
    if (error instanceof Stripe.errors.StripeError) {
      return new DomainError(
        `${context}: ${error.message}`,
        'PAYMENT_PROVIDER_UNAVAILABLE',
      );
    }
    if (error instanceof Error) {
      return new DomainError(
        `${context}: ${error.message}`,
        'PAYMENT_PROVIDER_UNAVAILABLE',
      );
    }
    return new DomainError(
      `${context}: unknown error`,
      'PAYMENT_PROVIDER_UNAVAILABLE',
    );
  }
}
