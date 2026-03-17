import { DomainError } from '../errors/DomainError';
import { EscrowStatus } from '../enums/EscrowStatus';

/**
 * Canonical payment-provider webhook event types.
 *
 * These are the ONLY event types the system processes.
 * Maps to Stripe event naming; the actual Stripe event type
 * string is the value.
 */
export enum PaymentEventType {
  PAYMENT_AUTHORIZED = 'payment_intent.authorized',
  PAYMENT_CAPTURED = 'payment_intent.captured',
  CHARGE_REFUNDED = 'charge.refunded',
  DISPUTE_OPENED = 'charge.dispute.created',
  DISPUTE_CLOSED = 'charge.dispute.closed',
}

const ALL_PAYMENT_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(PaymentEventType),
);

/**
 * For each event type, which escrow statuses are valid preconditions.
 *
 * If the rental is not in one of these statuses when the event arrives,
 * the event is either out-of-order, duplicate, or a regression attempt.
 *
 * This map mirrors the Rental entity's VALID_TRANSITIONS but from the
 * perspective of external events. It is intentionally conservative:
 * the entity FSM is the ultimate gatekeeper, but this pre-dispatch check
 * produces structured, diagnosable rejection reasons instead of generic
 * transition errors.
 */
const VALID_PRECONDITIONS: ReadonlyMap<PaymentEventType, ReadonlySet<EscrowStatus>> =
  new Map<PaymentEventType, ReadonlySet<EscrowStatus>>([
    [
      PaymentEventType.PAYMENT_AUTHORIZED,
      new Set<EscrowStatus>([EscrowStatus.AWAITING_EXTERNAL_PAYMENT]),
    ],
    [
      PaymentEventType.PAYMENT_CAPTURED,
      new Set<EscrowStatus>([EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED]),
    ],
    [
      PaymentEventType.CHARGE_REFUNDED,
      new Set<EscrowStatus>([
        EscrowStatus.AWAITING_EXTERNAL_PAYMENT,
        EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
        EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
      ]),
    ],
    [
      PaymentEventType.DISPUTE_OPENED,
      new Set<EscrowStatus>([
        EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
        EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
      ]),
    ],
    [
      PaymentEventType.DISPUTE_CLOSED,
      new Set<EscrowStatus>([EscrowStatus.DISPUTED]),
    ],
  ]);

/**
 * The escrow status that each event type transitions TO.
 * Used to detect duplicate events (rental already in target state).
 */
const TARGET_STATE: ReadonlyMap<PaymentEventType, EscrowStatus> = new Map([
  [PaymentEventType.PAYMENT_AUTHORIZED, EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED],
  [PaymentEventType.PAYMENT_CAPTURED, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED],
  [PaymentEventType.CHARGE_REFUNDED, EscrowStatus.REFUNDED],
  [PaymentEventType.DISPUTE_OPENED, EscrowStatus.DISPUTED],
  // DISPUTE_CLOSED doesn't change escrow status — it clears disputeOpen flag
]);

export type WebhookValidationResult =
  | { readonly outcome: 'proceed' }
  | { readonly outcome: 'duplicate'; readonly reason: string }
  | { readonly outcome: 'rejected'; readonly reason: string; readonly code: string };

/**
 * Pre-dispatch webhook event validator.
 *
 * Validates that an incoming payment-provider event is:
 * 1. A recognized event type
 * 2. Targeting a rental in a valid precondition state
 * 3. Not a duplicate (rental already in target state)
 * 4. Not targeting a terminal rental (with narrow exception for refund)
 * 5. Not a state regression
 *
 * This is a domain service — pure logic, no side effects, no I/O.
 * It does NOT replace the entity FSM. It provides structured pre-flight
 * rejection reasons so the webhook controller can produce precise audit
 * entries and HTTP responses.
 */
export class WebhookEventValidator {
  /**
   * Check if a raw event type string is a supported payment event.
   */
  static isSupportedEventType(eventType: string): eventType is PaymentEventType {
    return ALL_PAYMENT_EVENT_TYPES.has(eventType);
  }

  /**
   * Validate whether an event can be applied to a rental.
   *
   * Returns one of:
   * - { outcome: 'proceed' } — event is valid, dispatch it
   * - { outcome: 'duplicate', reason } — event already applied, ack without processing
   * - { outcome: 'rejected', reason, code } — event is invalid for this rental state
   */
  static validate(
    eventType: PaymentEventType,
    currentStatus: EscrowStatus,
    disputeOpen: boolean,
  ): WebhookValidationResult {
    // Terminal-state check: no events allowed on terminal rentals,
    // EXCEPT that a rental already in REFUNDED getting another refund
    // event is a duplicate (not an error).
    const isTerminal =
      currentStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER ||
      currentStatus === EscrowStatus.REFUNDED;

    if (isTerminal) {
      // Check if this is a duplicate of the event that made it terminal
      const target = TARGET_STATE.get(eventType);
      if (target === currentStatus) {
        return {
          outcome: 'duplicate',
          reason: `Rental already in terminal state ${currentStatus}; event ${eventType} is a duplicate`,
        };
      }
      return {
        outcome: 'rejected',
        reason: `Rental is in terminal state ${currentStatus}; event ${eventType} cannot be applied`,
        code: 'INVALID_ESCROW_TRANSITION',
      };
    }

    // Duplicate detection: rental is already in the target state for this event
    const targetState = TARGET_STATE.get(eventType);
    if (targetState && targetState === currentStatus) {
      return {
        outcome: 'duplicate',
        reason: `Rental already in state ${currentStatus}; event ${eventType} is a duplicate delivery`,
      };
    }

    // Special case: DISPUTE_CLOSED on DISPUTED with dispute already resolved
    if (eventType === PaymentEventType.DISPUTE_CLOSED && currentStatus === EscrowStatus.DISPUTED && !disputeOpen) {
      return {
        outcome: 'duplicate',
        reason: 'Dispute already resolved on this rental; event is a duplicate delivery',
      };
    }

    // Precondition check: is the rental in a valid state for this event?
    const validPreconditions = VALID_PRECONDITIONS.get(eventType);
    if (!validPreconditions || !validPreconditions.has(currentStatus)) {
      return {
        outcome: 'rejected',
        reason: `Event ${eventType} requires rental in state [${[...(validPreconditions ?? [])].join(', ')}], but rental is in ${currentStatus}`,
        code: 'INVALID_ESCROW_TRANSITION',
      };
    }

    return { outcome: 'proceed' };
  }
}
