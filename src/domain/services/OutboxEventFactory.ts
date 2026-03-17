import { OutboxEvent, OutboxEventTopic } from '../entities/OutboxEvent';

/**
 * Factory for creating well-formed outbox events.
 *
 * Centralizes dedup key generation and payload construction.
 * Each method maps to exactly one outbox topic.
 */
export class OutboxEventFactory {
  /**
   * payment.checkout_session.create
   * Dedup key: rental ID (one checkout session per rental)
   */
  static checkoutSession(params: {
    rentalId: string;
    renterId: string;
    watchId: string;
    ownerId: string;
    amount: number;
    currency: string;
  }): OutboxEvent {
    return OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.checkout_session.create',
      aggregateType: 'Rental',
      aggregateId: params.rentalId,
      payload: { ...params },
      dedupKey: `checkout:${params.rentalId}`,
    });
  }

  /**
   * payment.capture
   * Dedup key: rental ID (one capture per rental)
   */
  static capturePayment(params: {
    rentalId: string;
    paymentIntentId: string;
  }): OutboxEvent {
    return OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.capture',
      aggregateType: 'Rental',
      aggregateId: params.rentalId,
      payload: { ...params },
      dedupKey: `capture:${params.rentalId}`,
    });
  }

  /**
   * payment.refund
   * Dedup key: rental ID (one refund per rental)
   */
  static refundPayment(params: {
    rentalId: string;
    paymentIntentId: string;
  }): OutboxEvent {
    return OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.refund',
      aggregateType: 'Rental',
      aggregateId: params.rentalId,
      payload: { ...params },
      dedupKey: `refund:${params.rentalId}`,
    });
  }

  /**
   * payment.transfer_to_owner
   * Dedup key: rental ID (one transfer per rental)
   */
  static transferToOwner(params: {
    rentalId: string;
    amount: number;
    connectedAccountId: string;
  }): OutboxEvent {
    return OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.transfer_to_owner',
      aggregateType: 'Rental',
      aggregateId: params.rentalId,
      payload: { ...params },
      dedupKey: `transfer:${params.rentalId}`,
    });
  }

  /**
   * payment.connected_account.create
   * Dedup key: owner ID (one connected account per owner)
   */
  static createConnectedAccount(params: {
    ownerId: string;
    email: string;
    country: string;
  }): OutboxEvent {
    return OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.connected_account.create',
      aggregateType: 'User',
      aggregateId: params.ownerId,
      payload: { ...params },
      dedupKey: `connected_account:${params.ownerId}`,
    });
  }

  /**
   * payment.onboarding_link.create
   * Dedup key: connected account ID + timestamp bucket (links expire)
   */
  static createOnboardingLink(params: {
    connectedAccountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): OutboxEvent {
    return OutboxEvent.create({
      id: crypto.randomUUID(),
      topic: 'payment.onboarding_link.create',
      aggregateType: 'User',
      aggregateId: params.connectedAccountId,
      payload: { ...params },
      dedupKey: `onboarding:${params.connectedAccountId}:${Date.now()}`,
    });
  }
}
