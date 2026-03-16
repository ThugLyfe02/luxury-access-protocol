import { DomainError } from '../../domain/errors/DomainError';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { Rental } from '../../domain/entities/Rental';
import { ManualReviewCase } from '../../domain/entities/ManualReviewCase';
import { RegulatoryGuardrails } from '../../domain/services/RegulatoryGuardrails';

/**
 * Orchestrates interaction between the platform and the external payment
 * provider (Stripe Connect). The platform never holds rental principal.
 *
 * All fund movement is instructed via PaymentProvider — the platform
 * reacts to external payment events, it does not warehouse funds.
 */
export class MarketplacePaymentService {
  private readonly paymentProvider: PaymentProvider;

  constructor(paymentProvider: PaymentProvider) {
    this.paymentProvider = paymentProvider;
  }

  /**
   * Handle external event: payment authorized by Stripe.
   * Renter's card has been authorized but not yet captured.
   */
  async handlePaymentAuthorized(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_payment_authorized',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot authorize payment without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    rental.markPaymentAuthorized();
  }

  /**
   * Handle external event: payment captured by Stripe.
   * Funds have been captured from renter's payment method by Stripe,
   * not by the platform.
   */
  async handlePaymentCaptured(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_payment_captured',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot capture payment without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    const { captured } = await this.paymentProvider.capturePayment(
      rental.externalPaymentIntentId,
    );

    if (!captured) {
      throw new DomainError(
        'External payment provider failed to capture payment',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    rental.markPaymentCaptured();
  }

  /**
   * Handle external event: payment refunded via Stripe.
   * Stripe returns funds to renter — platform does not touch principal.
   */
  async handlePaymentRefunded(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_payment_refunded',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot refund payment without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    const { refunded } = await this.paymentProvider.refundPayment(
      rental.externalPaymentIntentId,
    );

    if (!refunded) {
      throw new DomainError(
        'External payment provider failed to refund payment',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    rental.markRefunded();
  }

  /**
   * Handle dispute opened on external payment.
   * Freezes the rental — no release possible while dispute is open.
   */
  async handleDisputeOpened(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_dispute_opened',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    rental.markDisputed();
  }

  /**
   * Handle dispute resolved — clears the dispute lock.
   * Does NOT automatically release funds or transition state.
   * The rental remains in DISPUTED escrow status with disputeOpen=false.
   * To proceed toward release, the rental must be explicitly transitioned
   * back to CAPTURED state via restoreToCaptured(). No magical release path.
   */
  async handleDisputeResolved(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_dispute_resolved',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    rental.resolveDispute();
  }

  /**
   * Confirm physical return of the watch.
   * Gated by entity: only allowed when payment is captured or disputed.
   */
  async confirmReturn(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'confirm_return',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    rental.confirmReturn();
  }

  /**
   * Restore a disputed rental to CAPTURED state after dispute resolution.
   * Requires: dispute must be resolved (disputeOpen === false) and
   * current escrow status must be DISPUTED.
   * This is the only path from DISPUTED back to the normal release flow.
   */
  async restoreDisputedToCaptured(rental: Rental): Promise<void> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'restore_disputed_to_captured',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (rental.escrowStatus !== EscrowStatus.DISPUTED) {
      throw new DomainError(
        'Can only restore to captured from DISPUTED state',
        'INVALID_ESCROW_TRANSITION',
      );
    }

    rental.restoreToCaptured();
  }

  private rejectIfTerminal(rental: Rental): void {
    if (rental.isTerminal()) {
      throw new DomainError(
        `Rental ${rental.id} is in terminal state ${rental.escrowStatus} — no further transitions allowed`,
        'INVALID_ESCROW_TRANSITION',
      );
    }
  }

  /**
   * Instruct Stripe Connect to transfer owner's share to their
   * connected account. The platform instructs the external provider
   * to move funds — it never holds or moves principal itself.
   *
   * ALL preconditions are verified before instructing the transfer.
   * The external transfer is executed BEFORE the entity transitions
   * to the terminal FUNDS_RELEASED_TO_OWNER state. This ordering
   * ensures that if the external provider fails, the rental remains
   * in CAPTURED state and the operation can be retried.
   *
   * This method hard-fails if any gate is unsatisfied.
   */
  async releaseToOwner(params: {
    rental: Rental;
    ownerConnectedAccountId: string;
    ownerShareAmount: number;
    blockingReviewCases: ManualReviewCase[];
  }): Promise<{ transferId: string }> {
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'release_to_owner',
      { rentalId: params.rental.id, amount: params.ownerShareAmount },
    );

    // Gate 1: Rental must not already be in a terminal state
    if (params.rental.isTerminal()) {
      throw new DomainError(
        'Cannot release funds: rental is in a terminal state',
        'INVALID_ESCROW_TRANSITION',
      );
    }

    // Gate 2: Payment must be captured (entity-enforced via FSM)
    if (params.rental.escrowStatus !== EscrowStatus.EXTERNAL_PAYMENT_CAPTURED) {
      throw new DomainError(
        'Cannot release funds: external payment not in captured state',
        'INVALID_ESCROW_TRANSITION',
      );
    }

    // Gate 3: Return must be confirmed (entity-enforced)
    if (!params.rental.returnConfirmed) {
      throw new DomainError(
        'Cannot release funds without confirmed return',
        'RETURN_NOT_CONFIRMED',
      );
    }

    // Gate 4: No open dispute (entity-enforced)
    if (params.rental.disputeOpen) {
      throw new DomainError(
        'Cannot release funds while dispute is open',
        'DISPUTE_LOCK',
      );
    }

    // Gate 5: No blocking manual review cases
    const blockingCases = params.blockingReviewCases.filter(
      (c) => c.isBlocking(),
    );
    if (blockingCases.length > 0) {
      throw new DomainError(
        'Cannot release funds with unresolved blocking review cases',
        'REVIEW_REQUIRED',
      );
    }

    // Gate 6: Owner connected account must be provided
    if (!params.ownerConnectedAccountId) {
      throw new DomainError(
        'Owner connected account ID is required for transfer',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    // Gate 7: Share amount must be positive and finite
    if (params.ownerShareAmount <= 0 || !Number.isFinite(params.ownerShareAmount)) {
      throw new DomainError(
        'Owner share amount must be a positive finite number',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    // Gate 8: Share amount must not exceed rental price (ceiling check)
    if (params.ownerShareAmount > params.rental.rentalPrice) {
      throw new DomainError(
        'Owner share amount cannot exceed the rental price',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    // Gate 9: External payment intent must exist (defense-in-depth)
    if (!params.rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot release funds without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    // Instruct external provider to transfer to owner's connected account.
    // This is executed BEFORE the entity transition so that if the external
    // provider fails, the rental remains in CAPTURED state and can be retried.
    const { transferId } = await this.paymentProvider.transferToConnectedAccount({
      amount: params.ownerShareAmount,
      connectedAccountId: params.ownerConnectedAccountId,
      rentalId: params.rental.id,
    });

    // Entity-level transition to terminal FUNDS_RELEASED_TO_OWNER state.
    // This also re-checks return + dispute gates at the entity level.
    params.rental.releaseFunds();

    return { transferId };
  }
}
