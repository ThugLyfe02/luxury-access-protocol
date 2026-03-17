import { OutboxEvent } from '../../domain/entities/OutboxEvent';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { OutboxEventHandler } from './OutboxDispatcher';

/**
 * Handler: payment.checkout_session.create
 *
 * Creates a checkout session via the payment provider.
 * Idempotent: if the session already exists for this rental,
 * the provider should return the existing session.
 */
export class CreateCheckoutSessionHandler implements OutboxEventHandler {
  constructor(private readonly provider: PaymentProvider) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const p = event.payload;
    const result = await this.provider.createCheckoutSession({
      rentalId: p.rentalId as string,
      renterId: p.renterId as string,
      watchId: p.watchId as string,
      ownerId: p.ownerId as string,
      amount: p.amount as number,
      currency: p.currency as string,
    });
    return { sessionId: result.sessionId, paymentIntentId: result.paymentIntentId };
  }
}

/**
 * Handler: payment.capture
 *
 * Captures a previously authorized payment.
 * Idempotent: double-capture returns the same result from the provider.
 */
export class CapturePaymentHandler implements OutboxEventHandler {
  constructor(private readonly provider: PaymentProvider) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const result = await this.provider.capturePayment(event.payload.paymentIntentId as string);
    return { captured: result.captured };
  }
}

/**
 * Handler: payment.refund
 *
 * Refunds a payment via the provider.
 * Idempotent: double-refund returns the same result from the provider.
 */
export class RefundPaymentHandler implements OutboxEventHandler {
  constructor(private readonly provider: PaymentProvider) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const result = await this.provider.refundPayment(event.payload.paymentIntentId as string);
    return { refunded: result.refunded };
  }
}

/**
 * Handler: payment.transfer_to_owner
 *
 * Transfers the owner's share to their connected account.
 * Idempotent: provider uses rentalId for dedup.
 */
export class TransferToOwnerHandler implements OutboxEventHandler {
  constructor(private readonly provider: PaymentProvider) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const p = event.payload;
    const result = await this.provider.transferToConnectedAccount({
      amount: p.amount as number,
      connectedAccountId: p.connectedAccountId as string,
      rentalId: p.rentalId as string,
    });
    return { transferId: result.transferId };
  }
}

/**
 * Handler: payment.connected_account.create
 *
 * Creates a connected account for an owner.
 */
export class CreateConnectedAccountHandler implements OutboxEventHandler {
  constructor(private readonly provider: PaymentProvider) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const p = event.payload;
    const result = await this.provider.createConnectedAccount({
      ownerId: p.ownerId as string,
      email: p.email as string,
      country: p.country as string,
    });
    return { connectedAccountId: result.connectedAccountId };
  }
}

/**
 * Handler: payment.onboarding_link.create
 *
 * Generates an onboarding link for owner account setup.
 */
export class CreateOnboardingLinkHandler implements OutboxEventHandler {
  constructor(private readonly provider: PaymentProvider) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const p = event.payload;
    const result = await this.provider.createOnboardingLink({
      connectedAccountId: p.connectedAccountId as string,
      returnUrl: p.returnUrl as string,
      refreshUrl: p.refreshUrl as string,
    });
    return { url: result.url };
  }
}
