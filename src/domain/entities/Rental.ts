import { DomainError } from '../errors/DomainError';
import { EscrowStatus } from '../enums/EscrowStatus';

const VALID_TRANSITIONS: ReadonlyMap<EscrowStatus, ReadonlySet<EscrowStatus>> =
  new Map([
    [
      EscrowStatus.NOT_STARTED,
      new Set([EscrowStatus.AWAITING_EXTERNAL_PAYMENT]),
    ],
    [
      EscrowStatus.AWAITING_EXTERNAL_PAYMENT,
      new Set([EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED, EscrowStatus.REFUNDED]),
    ],
    [
      EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED,
      new Set([
        EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
        EscrowStatus.REFUNDED,
        EscrowStatus.DISPUTED,
      ]),
    ],
    [
      EscrowStatus.EXTERNAL_PAYMENT_CAPTURED,
      new Set([
        EscrowStatus.FUNDS_RELEASED_TO_OWNER,
        EscrowStatus.DISPUTED,
        EscrowStatus.REFUNDED,
      ]),
    ],
    [
      EscrowStatus.DISPUTED,
      new Set([EscrowStatus.REFUNDED, EscrowStatus.EXTERNAL_PAYMENT_CAPTURED]),
    ],
    [EscrowStatus.FUNDS_RELEASED_TO_OWNER, new Set<EscrowStatus>()],
    [EscrowStatus.REFUNDED, new Set<EscrowStatus>()],
  ]);

export class Rental {
  readonly id: string;
  readonly renterId: string;
  readonly watchId: string;
  readonly rentalPrice: number;
  readonly createdAt: Date;
  private _escrowStatus: EscrowStatus;
  private _externalPaymentIntentId: string | null;

  constructor(params: {
    id: string;
    renterId: string;
    watchId: string;
    rentalPrice: number;
    escrowStatus: EscrowStatus;
    externalPaymentIntentId: string | null;
    createdAt: Date;
  }) {
    if (!params.id) {
      throw new DomainError('Rental ID is required', 'INVALID_RENTAL_DATES');
    }

    if (!params.renterId) {
      throw new DomainError('Renter ID is required', 'INVALID_RENTAL_PARTIES');
    }

    if (!params.watchId) {
      throw new DomainError('Watch ID is required', 'INVALID_RENTAL_PARTIES');
    }

    if (params.rentalPrice <= 0) {
      throw new DomainError(
        'Rental price must be greater than zero',
        'INVALID_VALUATION',
      );
    }

    this.id = params.id;
    this.renterId = params.renterId;
    this.watchId = params.watchId;
    this.rentalPrice = params.rentalPrice;
    this._escrowStatus = params.escrowStatus;
    this._externalPaymentIntentId = params.externalPaymentIntentId;
    this.createdAt = params.createdAt;
  }

  get escrowStatus(): EscrowStatus {
    return this._escrowStatus;
  }

  get externalPaymentIntentId(): string | null {
    return this._externalPaymentIntentId;
  }

  private transitionTo(nextStatus: EscrowStatus): void {
    const allowed = VALID_TRANSITIONS.get(this._escrowStatus);
    if (!allowed || !allowed.has(nextStatus)) {
      throw new DomainError(
        `Invalid escrow transition from ${this._escrowStatus} to ${nextStatus}`,
        'INVALID_ESCROW_TRANSITION',
      );
    }
    this._escrowStatus = nextStatus;
  }

  startExternalPayment(sessionId: string): void {
    if (!sessionId) {
      throw new DomainError(
        'External payment session ID is required',
        'INVALID_PAYMENT_TRANSITION',
      );
    }
    this.transitionTo(EscrowStatus.AWAITING_EXTERNAL_PAYMENT);
    this._externalPaymentIntentId = sessionId;
  }

  markPaymentAuthorized(): void {
    this.transitionTo(EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED);
  }

  markPaymentCaptured(): void {
    this.transitionTo(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
  }

  releaseFunds(): void {
    this.transitionTo(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
  }

  markDisputed(): void {
    this.transitionTo(EscrowStatus.DISPUTED);
  }

  markRefunded(): void {
    this.transitionTo(EscrowStatus.REFUNDED);
  }
}
