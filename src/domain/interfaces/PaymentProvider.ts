/**
 * Provider-neutral payment operations contract.
 *
 * This interface defines the capabilities the platform requires from an
 * external payment provider (e.g., Stripe Connect). It deliberately uses
 * no provider-specific types — all inputs and outputs are plain objects.
 *
 * Anti-custody architecture:
 * - The platform orchestrates payment flows through this interface.
 * - The platform NEVER holds rental principal.
 * - Fund movement is always between external parties (renter ↔ provider ↔ owner).
 * - The platform collects only its application fee via the provider.
 */
export interface PaymentProvider {
  /**
   * Create a connected account for a watch owner so they can receive
   * payouts via the external provider's Connect/marketplace infrastructure.
   */
  createConnectedAccount(params: {
    ownerId: string;
    email: string;
    country: string;
  }): Promise<{ connectedAccountId: string }>;

  /**
   * Generate an onboarding link for an owner to complete their
   * connected account setup (identity verification, bank details, etc.).
   */
  createOnboardingLink(params: {
    connectedAccountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }>;

  /**
   * Create a checkout session for a renter to pay for a rental.
   *
   * Returns both the checkout session ID (for redirect) and the
   * underlying payment intent ID (for subsequent operations like
   * capture, refund, and webhook correlation).
   *
   * The payment is authorized but NOT captured — capture happens
   * only after deterministic business events (e.g., watch delivery).
   */
  createCheckoutSession(params: {
    rentalId: string;
    renterId: string;
    watchId: string;
    ownerId: string;
    amount: number;
    currency: string;
  }): Promise<{ sessionId: string; paymentIntentId: string }>;

  /**
   * Capture a previously authorized payment.
   * Called by the platform after deterministic business events,
   * never on discretionary basis.
   */
  capturePayment(paymentIntentId: string): Promise<{ captured: boolean }>;

  /**
   * Initiate a refund on a payment through the external provider.
   * The provider returns funds to the renter — the platform does not
   * handle principal.
   */
  refundPayment(paymentIntentId: string): Promise<{ refunded: boolean }>;

  /**
   * Instruct the external provider to transfer the owner's share
   * to their connected account. This is the ONLY mechanism by which
   * an owner receives funds — no internal balance, no platform custody.
   */
  transferToConnectedAccount(params: {
    amount: number;
    connectedAccountId: string;
    rentalId: string;
  }): Promise<{ transferId: string }>;
}
