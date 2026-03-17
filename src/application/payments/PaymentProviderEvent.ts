/**
 * Provider-neutral normalized payment event.
 *
 * All payment provider webhooks are normalized to this shape before
 * reaching application or domain logic. No raw Stripe (or other
 * provider) types cross this boundary.
 *
 * The application layer uses these events to drive deterministic
 * state transitions on Rental and related entities.
 */

/**
 * Canonical event types the application recognizes.
 * These are provider-agnostic semantic names.
 */
export enum NormalizedEventType {
  /** Auth hold placed — renter completed checkout, funds authorized */
  PAYMENT_AUTHORIZED = 'payment_authorized',
  /** Payment captured — funds moved from renter to provider custody */
  PAYMENT_CAPTURED = 'payment_captured',
  /** Refund processed — provider returned funds to renter */
  PAYMENT_REFUNDED = 'payment_refunded',
  /** Dispute/chargeback opened — blocks release */
  DISPUTE_OPENED = 'dispute_opened',
  /** Dispute closed — dispute resolved (may or may not be in platform's favor) */
  DISPUTE_CLOSED = 'dispute_closed',
}

export interface PaymentProviderEvent {
  /** Unique event ID from the external provider (for dedup) */
  readonly externalEventId: string;
  /** Normalized event type */
  readonly type: NormalizedEventType;
  /** The external payment intent / charge ID used to correlate with a Rental */
  readonly externalPaymentIntentId: string;
  /** External checkout session ID, if applicable */
  readonly externalCheckoutSessionId: string | null;
  /** Connected account ID involved, if applicable */
  readonly connectedAccountId: string | null;
  /** Refund amount in cents, if this is a refund event */
  readonly refundAmountCents: number | null;
  /** Whether the dispute was won by the platform (only for DISPUTE_CLOSED) */
  readonly disputeWonByPlatform: boolean | null;
  /** Raw external reference ID (e.g., charge ID, dispute ID) */
  readonly rawReferenceId: string;
  /** When the event occurred */
  readonly occurredAt: Date;
}
