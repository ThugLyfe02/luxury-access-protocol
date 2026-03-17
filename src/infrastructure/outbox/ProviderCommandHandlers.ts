import { OutboxEvent } from '../../domain/entities/OutboxEvent';
import { DomainError } from '../../domain/errors/DomainError';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { OutboxEventHandler } from './OutboxDispatcher';

/**
 * Validate a required string field from outbox event payload.
 * Throws a permanent DomainError if missing — goes to dead letter, not retry.
 */
function requireString(payload: Readonly<Record<string, unknown>>, field: string, context: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value) {
    throw new DomainError(
      `Missing or invalid '${field}' in ${context} payload`,
      'INVALID_STATE_TRANSITION',
    );
  }
  return value;
}

/**
 * Validate a required number field from outbox event payload.
 */
function requireNumber(payload: Readonly<Record<string, unknown>>, field: string, context: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DomainError(
      `Missing or invalid '${field}' in ${context} payload`,
      'INVALID_STATE_TRANSITION',
    );
  }
  return value;
}

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
    const rentalId = requireString(p, 'rentalId', 'checkout_session.create');
    const renterId = requireString(p, 'renterId', 'checkout_session.create');
    const watchId = requireString(p, 'watchId', 'checkout_session.create');
    const ownerId = requireString(p, 'ownerId', 'checkout_session.create');
    const amount = requireNumber(p, 'amount', 'checkout_session.create');
    const currency = requireString(p, 'currency', 'checkout_session.create');

    const result = await this.provider.createCheckoutSession({
      rentalId, renterId, watchId, ownerId, amount, currency,
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
    const paymentIntentId = requireString(event.payload, 'paymentIntentId', 'capture');
    const result = await this.provider.capturePayment(paymentIntentId);
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
    const paymentIntentId = requireString(event.payload, 'paymentIntentId', 'refund');
    const result = await this.provider.refundPayment(paymentIntentId);
    return { refunded: result.refunded };
  }
}

/**
 * Handler: payment.transfer_to_owner
 *
 * Transfers the owner's share to their connected account.
 * Idempotent: provider uses rentalId for dedup.
 *
 * After provider success, writes back the real Stripe transfer ID
 * to the Rental entity and advances the FSM to FUNDS_RELEASED_TO_OWNER.
 * This ensures reconciliation can verify transfer truth using real
 * provider identifiers.
 *
 * Crash-window safety:
 * - Provider call is idempotent (Stripe idempotency key: transfer_{rentalId})
 * - If rental is already in FUNDS_RELEASED_TO_OWNER, write-back is skipped
 * - Write-back failure does NOT prevent the handler from returning success.
 *   The real transferId is always returned so the outbox event captures it
 *   in its result field. This ensures provider truth is never lost even if
 *   the Rental write-back fails due to OCC conflict, dispute lock, or crash.
 * - Reconciliation uses the outbox event result as a fallback when
 *   Rental.externalTransferId is missing.
 */
export class TransferToOwnerHandler implements OutboxEventHandler {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly rentalRepo?: RentalRepository,
  ) {}

  async handle(event: OutboxEvent): Promise<Record<string, unknown>> {
    const p = event.payload;
    const amount = requireNumber(p, 'amount', 'transfer_to_owner');
    const connectedAccountId = requireString(p, 'connectedAccountId', 'transfer_to_owner');
    const rentalId = requireString(p, 'rentalId', 'transfer_to_owner');

    const result = await this.provider.transferToConnectedAccount({
      amount, connectedAccountId, rentalId,
    });

    // Provider succeeded — the real transferId MUST be returned regardless
    // of write-back outcome so the outbox event captures it durably.
    if (this.rentalRepo) {
      try {
        await this.completeRentalRelease(rentalId, result.transferId);
      } catch {
        // Write-back failed (OCC conflict, dispute lock, etc.)
        // Provider truth is preserved in the returned result — the outbox
        // event will be marked SUCCEEDED with { transferId } in its result
        // field, enabling reconciliation recovery.
      }
    }

    return { transferId: result.transferId };
  }

  /**
   * Write back real provider transfer ID and advance FSM.
   * Idempotent: skips if rental already in FUNDS_RELEASED_TO_OWNER.
   */
  private async completeRentalRelease(rentalId: string, transferId: string): Promise<void> {
    const rental = await this.rentalRepo!.findById(rentalId);
    if (!rental) return;

    // Already released — idempotent (replay after crash or duplicate processing)
    if (rental.escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER) {
      return;
    }

    // Expected state: EXTERNAL_PAYMENT_CAPTURED (verified at queue time).
    // releaseFunds() enforces returnConfirmed + !disputeOpen guards.
    rental.releaseFunds(transferId);
    await this.rentalRepo!.save(rental);
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
    const ownerId = requireString(p, 'ownerId', 'connected_account.create');
    const email = requireString(p, 'email', 'connected_account.create');
    const country = requireString(p, 'country', 'connected_account.create');

    const result = await this.provider.createConnectedAccount({ ownerId, email, country });
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
    const connectedAccountId = requireString(p, 'connectedAccountId', 'onboarding_link.create');
    const returnUrl = requireString(p, 'returnUrl', 'onboarding_link.create');
    const refreshUrl = requireString(p, 'refreshUrl', 'onboarding_link.create');

    const result = await this.provider.createOnboardingLink({
      connectedAccountId, returnUrl, refreshUrl,
    });
    return { url: result.url };
  }
}
