import { DomainError } from '../../domain/errors/DomainError';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { Rental } from '../../domain/entities/Rental';
import { ManualReviewCase } from '../../domain/entities/ManualReviewCase';
import { RegulatoryGuardrails } from '../../domain/services/RegulatoryGuardrails';
import { InsuranceClaim } from '../../domain/entities/InsuranceClaim';
import { InsuranceGatePolicy } from '../../domain/services/InsuranceGatePolicy';
import { ReviewFreezePolicy } from '../../domain/services/ReviewFreezePolicy';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';
import { AuditLog } from '../audit/AuditLog';
import { OutboxRepository } from '../../domain/interfaces/OutboxRepository';
import { OutboxEventFactory } from '../../domain/services/OutboxEventFactory';
import { OutboxEvent } from '../../domain/entities/OutboxEvent';

/**
 * Orchestrates interaction between the platform and the external payment
 * provider (Stripe Connect). The platform never holds rental principal.
 *
 * All fund movement is instructed via PaymentProvider — the platform
 * reacts to external payment events, it does not warehouse funds.
 *
 * Method naming convention:
 * - handle*  = passive acknowledgment of an external event (webhook-driven)
 * - request* = active operation that calls the payment provider (or writes outbox event)
 *
 * When an OutboxRepository is provided, active operations write durable
 * outbox events instead of calling the provider directly. The outbox worker
 * processes these events asynchronously with retry and dead-letter support.
 */
export class MarketplacePaymentService {
  private readonly paymentProvider: PaymentProvider;
  private readonly auditLog: AuditLog;
  private readonly outboxRepo: OutboxRepository | null;

  /**
   * Tracks rental IDs for which a release has been initiated.
   * Prevents duplicate transfers if releaseToOwner is retried.
   * In production, this would be backed by a persistent store.
   */
  private readonly releasedRentalIds = new Set<string>();

  constructor(paymentProvider: PaymentProvider, auditLog: AuditLog, outboxRepo?: OutboxRepository) {
    this.paymentProvider = paymentProvider;
    this.auditLog = auditLog;
    this.outboxRepo = outboxRepo ?? null;
  }

  /**
   * Handle external event: payment authorized.
   * Restricted to system actors (webhook callbacks).
   *
   * This is a PASSIVE acknowledgment — the authorization already happened
   * externally (renter completed checkout). No provider API call is made.
   */
  async handlePaymentAuthorized(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystem(actor);

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

    const beforeState = rental.escrowStatus;
    rental.markPaymentAuthorized();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'payment_authorized',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });
  }

  /**
   * Handle external event: payment failed.
   * Restricted to system actors (webhook callbacks).
   *
   * This is a PASSIVE acknowledgment — the failure was reported by the provider.
   * No escrow state mutation occurs because:
   * - The renter may retry the payment (Stripe allows retry on the same PI)
   * - A later success webhook will advance the FSM normally
   * - Terminally mutating on failure would block legitimate retry paths
   *
   * The event is recorded in the audit log for observability.
   */
  async handlePaymentFailed(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystem(actor);

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'payment_failed',
      outcome: 'success',
      beforeState: rental.escrowStatus,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });
  }

  /**
   * Actively request payment capture from the external provider.
   *
   * Called by business logic after deterministic events (e.g., watch
   * delivered to renter). NOT called from webhook handlers.
   *
   * The provider captures the previously authorized hold. After this
   * succeeds, the rental transitions to CAPTURED.
   */
  async requestCapture(actor: Actor, rental: Rental): Promise<OutboxEvent | null> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'request_capture',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot capture payment without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    if (this.outboxRepo) {
      // Outbox mode: write durable event, worker executes capture
      const outboxEvent = OutboxEventFactory.capturePayment({
        rentalId: rental.id,
        paymentIntentId: rental.externalPaymentIntentId,
      });
      await this.outboxRepo.create(outboxEvent);

      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: rental.id,
        action: 'payment_capture_queued',
        outcome: 'success',
        afterState: rental.escrowStatus,
        externalRef: outboxEvent.id,
      });

      return outboxEvent;
    }

    // Direct mode: call provider synchronously
    const { captured } = await this.paymentProvider.capturePayment(
      rental.externalPaymentIntentId,
    );

    if (!captured) {
      throw new DomainError(
        'External payment provider failed to capture payment',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    const beforeState = rental.escrowStatus;
    rental.markPaymentCaptured();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'payment_captured',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });

    return null;
  }

  /**
   * Handle external event: payment captured by provider.
   * Restricted to system actors (webhook callbacks).
   *
   * PASSIVE acknowledgment — the capture already happened externally
   * (either via our requestCapture call or a Stripe auto-capture).
   * No provider API call is made.
   */
  async handlePaymentCaptured(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystem(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_payment_captured',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot acknowledge capture without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    const beforeState = rental.escrowStatus;
    rental.markPaymentCaptured();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'payment_captured',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });
  }

  /**
   * Actively request refund from the external provider.
   *
   * Called by business logic or admin action. The provider returns
   * funds to the renter — the platform does not handle principal.
   */
  async requestRefund(actor: Actor, rental: Rental): Promise<OutboxEvent | null> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'request_refund',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot refund payment without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    if (this.outboxRepo) {
      // Outbox mode: write durable event, worker executes refund
      const outboxEvent = OutboxEventFactory.refundPayment({
        rentalId: rental.id,
        paymentIntentId: rental.externalPaymentIntentId,
      });
      await this.outboxRepo.create(outboxEvent);

      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: rental.id,
        action: 'payment_refund_queued',
        outcome: 'success',
        afterState: rental.escrowStatus,
        externalRef: outboxEvent.id,
      });

      return outboxEvent;
    }

    // Direct mode: call provider synchronously
    const { refunded } = await this.paymentProvider.refundPayment(
      rental.externalPaymentIntentId,
    );

    if (!refunded) {
      throw new DomainError(
        'External payment provider failed to refund payment',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    const beforeState = rental.escrowStatus;
    rental.markRefunded();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'payment_refunded',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });

    return null;
  }

  /**
   * Handle external event: payment refunded via provider webhook.
   * Restricted to system actors.
   *
   * PASSIVE acknowledgment — the refund already happened externally.
   * No provider API call is made.
   */
  async handlePaymentRefunded(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystem(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_payment_refunded',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    if (!rental.externalPaymentIntentId) {
      throw new DomainError(
        'Cannot acknowledge refund without external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    const beforeState = rental.escrowStatus;
    rental.markRefunded();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'payment_refunded',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });
  }

  /**
   * Handle dispute opened on external payment.
   * Restricted to system actors (webhook callbacks).
   * Freezes the rental — no release possible while dispute is open.
   */
  async handleDisputeOpened(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystem(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_dispute_opened',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    const beforeState = rental.escrowStatus;
    rental.markDisputed();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'dispute_opened',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
      externalRef: rental.externalPaymentIntentId,
    });
  }

  /**
   * Handle dispute resolved — clears the dispute lock.
   * Restricted to system actors (webhook callbacks).
   * Does NOT automatically release funds or transition state.
   * The rental remains in DISPUTED escrow status with disputeOpen=false.
   * To proceed toward release, the rental must be explicitly transitioned
   * back to CAPTURED state via restoreToCaptured(). No magical release path.
   */
  async handleDisputeResolved(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystem(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'handle_dispute_resolved',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    rental.resolveDispute();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'dispute_resolved',
      outcome: 'success',
      afterState: `${rental.escrowStatus}:disputeOpen=${rental.disputeOpen}`,
      externalRef: rental.externalPaymentIntentId,
    });
  }

  /**
   * Confirm physical return of the watch.
   * Restricted to the watch owner or an admin — renter cannot self-confirm.
   * Gated by entity: only allowed when payment is captured or disputed.
   */
  async confirmReturn(
    actor: Actor,
    rental: Rental,
    watchOwnerId: string,
  ): Promise<void> {
    AuthorizationGuard.requireSelfOrAdmin(actor, watchOwnerId);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'confirm_return',
      { rentalId: rental.id },
    );

    this.rejectIfTerminal(rental);

    rental.confirmReturn();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'confirm_return',
      outcome: 'success',
      afterState: `${rental.escrowStatus}:returnConfirmed=${rental.returnConfirmed}`,
    });
  }

  /**
   * Restore a disputed rental to CAPTURED state after dispute resolution.
   * Restricted to system actors or admin users.
   * Requires: dispute must be resolved (disputeOpen === false) and
   * current escrow status must be DISPUTED.
   * This is the only path from DISPUTED back to the normal release flow.
   */
  async restoreDisputedToCaptured(actor: Actor, rental: Rental): Promise<void> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

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

    const beforeState = rental.escrowStatus;
    rental.restoreToCaptured();

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: rental.id,
      action: 'restore_disputed_to_captured',
      outcome: 'success',
      beforeState,
      afterState: rental.escrowStatus,
    });
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
   * Idempotency: if releaseToOwner has already been called for this
   * rental, the method rejects with RELEASE_NOT_ALLOWED. This prevents
   * duplicate transfers even if the method is retried.
   */
  async releaseToOwner(
    actor: Actor,
    params: {
      rental: Rental;
      ownerConnectedAccountId: string;
      ownerShareAmount: number;
      blockingReviewCases: ManualReviewCase[];
      openClaims: InsuranceClaim[];
    },
  ): Promise<{ transferId: string }> {
    AuthorizationGuard.requireSystemOrAdmin(actor);

    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'release_to_owner',
      { rentalId: params.rental.id, amount: params.ownerShareAmount },
    );

    // Gate 0: Idempotency — prevent duplicate releases
    if (this.releasedRentalIds.has(params.rental.id)) {
      throw new DomainError(
        'Release has already been initiated for this rental',
        'RELEASE_NOT_ALLOWED',
      );
    }

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

    // Gate 5: No blocking manual review cases (freeze check)
    ReviewFreezePolicy.assertRentalNotFrozenForRelease(
      params.rental.id,
      params.blockingReviewCases,
    );

    // Gate 5b: No open insurance claims on rental or watch
    InsuranceGatePolicy.assertInsuranceClearForRelease(
      params.rental.id,
      params.rental.watchId,
      params.openClaims,
    );

    // Gate 6: Owner connected account must be provided
    if (!params.ownerConnectedAccountId) {
      throw new DomainError(
        'Owner connected account ID is required for transfer',
        'CONNECTED_ACCOUNT_MISSING',
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

    if (this.outboxRepo) {
      // Outbox mode: write durable transfer event, worker executes
      const outboxEvent = OutboxEventFactory.transferToOwner({
        rentalId: params.rental.id,
        amount: params.ownerShareAmount,
        connectedAccountId: params.ownerConnectedAccountId,
      });
      await this.outboxRepo.create(outboxEvent);

      // Mark as released to prevent duplicate transfers
      this.releasedRentalIds.add(params.rental.id);

      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: params.rental.id,
        action: 'release_to_owner_queued',
        outcome: 'success',
        afterState: params.rental.escrowStatus,
        externalRef: outboxEvent.id,
      });

      return { transferId: `outbox:${outboxEvent.id}` };
    }

    // Direct mode: instruct external provider to transfer to owner's connected account.
    // This is executed BEFORE the entity transition so that if the external
    // provider fails, the rental remains in CAPTURED state and can be retried.
    const { transferId } = await this.paymentProvider.transferToConnectedAccount({
      amount: params.ownerShareAmount,
      connectedAccountId: params.ownerConnectedAccountId,
      rentalId: params.rental.id,
    });

    // Mark as released BEFORE entity transition to prevent duplicate transfers
    // on retry. If the entity transition fails (shouldn't happen at this point),
    // the release is still recorded.
    this.releasedRentalIds.add(params.rental.id);

    // Entity-level transition to terminal FUNDS_RELEASED_TO_OWNER state.
    // This also re-checks return + dispute gates at the entity level.
    const beforeState = params.rental.escrowStatus;
    params.rental.releaseFunds(transferId);

    this.auditLog.record({
      actor,
      entityType: 'Rental',
      entityId: params.rental.id,
      action: 'release_to_owner',
      outcome: 'success',
      beforeState,
      afterState: params.rental.escrowStatus,
      externalRef: transferId,
    });

    return { transferId };
  }
}
