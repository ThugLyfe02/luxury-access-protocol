import Stripe from 'stripe';
import {
  ProviderSnapshotAdapter,
  ProviderPaymentSnapshot,
  ProviderPaymentStatus,
  ProviderConnectedAccountSnapshot,
} from '../../domain/reconciliation/ProviderSnapshot';
import { ProviderError } from '../../domain/errors/ProviderError';

/**
 * Real Stripe-backed provider snapshot adapter for reconciliation.
 *
 * Fetches payment intent and connected account state from Stripe
 * and normalizes into domain-friendly snapshot interfaces.
 *
 * Replaces StubProviderSnapshotAdapter in production environments.
 */
export class StripeProviderSnapshotAdapter implements ProviderSnapshotAdapter {
  constructor(private readonly stripe: Stripe) {}

  async fetchPaymentSnapshot(paymentIntentId: string): Promise<ProviderPaymentSnapshot | null> {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.dispute'],
      });
      return this.mapPaymentIntent(pi);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw new ProviderError({
        message: `fetchPaymentSnapshot: ${error instanceof Error ? error.message : 'unknown'}`,
        code: 'PROVIDER_UNAVAILABLE',
        isStateChanging: false,
      });
    }
  }

  async fetchConnectedAccountSnapshot(connectedAccountId: string): Promise<ProviderConnectedAccountSnapshot | null> {
    try {
      const account = await this.stripe.accounts.retrieve(connectedAccountId);
      return {
        connectedAccountId: account.id,
        chargesEnabled: account.charges_enabled ?? false,
        payoutsEnabled: account.payouts_enabled ?? false,
        detailsSubmitted: account.details_submitted ?? false,
        fetchedAt: new Date(),
      };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw new ProviderError({
        message: `fetchConnectedAccountSnapshot: ${error instanceof Error ? error.message : 'unknown'}`,
        code: 'PROVIDER_UNAVAILABLE',
        isStateChanging: false,
      });
    }
  }

  private mapPaymentIntent(pi: Stripe.PaymentIntent): ProviderPaymentSnapshot {
    const charge = typeof pi.latest_charge === 'object' && pi.latest_charge !== null
      ? pi.latest_charge as Stripe.Charge
      : null;

    let disputeStatus: string | null = null;
    let disputeOpen = false;
    if (charge?.disputed) {
      disputeOpen = true;
      // Dispute details are available when expanded; use the boolean for safety
      disputeStatus = 'open';
    }

    return {
      paymentIntentId: pi.id,
      status: this.mapStatus(pi.status),
      amountCaptured: charge?.amount_captured ?? 0,
      amountRefunded: charge?.amount_refunded ?? 0,
      currency: pi.currency,
      disputeOpen,
      disputeStatus,
      metadata: (pi.metadata ?? {}) as Readonly<Record<string, string>>,
      fetchedAt: new Date(),
    };
  }

  private mapStatus(status: string): ProviderPaymentStatus {
    const map: Record<string, ProviderPaymentStatus> = {
      requires_payment_method: 'requires_payment_method',
      requires_confirmation: 'requires_confirmation',
      requires_action: 'requires_action',
      processing: 'processing',
      requires_capture: 'requires_capture',
      canceled: 'canceled',
      succeeded: 'succeeded',
    };
    return map[status] ?? 'unknown';
  }

  private isNotFound(error: unknown): boolean {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      return error.statusCode === 404 || (error.message?.includes('No such') ?? false);
    }
    return false;
  }
}
