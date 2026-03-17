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

const ALL_ESCROW_STATUSES: ReadonlySet<string> = new Set(
  Object.values(EscrowStatus),
);

export class Rental {
  readonly id: string;
  readonly renterId: string;
  readonly watchId: string;
  readonly rentalPrice: number;
  readonly createdAt: Date;
  private _escrowStatus: EscrowStatus;
  private _externalPaymentIntentId: string | null;
  private _returnConfirmed: boolean;
  private _disputeOpen: boolean;
  private _externalTransferId: string | null;
  private _version: number;

  private constructor(params: {
    id: string;
    renterId: string;
    watchId: string;
    rentalPrice: number;
    escrowStatus: EscrowStatus;
    externalPaymentIntentId: string | null;
    externalTransferId: string | null;
    returnConfirmed: boolean;
    disputeOpen: boolean;
    createdAt: Date;
    version: number;
  }) {
    this.id = params.id;
    this.renterId = params.renterId;
    this.watchId = params.watchId;
    this.rentalPrice = params.rentalPrice;
    this._escrowStatus = params.escrowStatus;
    this._externalPaymentIntentId = params.externalPaymentIntentId;
    this._externalTransferId = params.externalTransferId;
    this._returnConfirmed = params.returnConfirmed;
    this._disputeOpen = params.disputeOpen;
    this.createdAt = params.createdAt;
    this._version = params.version;
  }

  /**
   * Create a new rental. Only valid initial state is NOT_STARTED.
   * returnConfirmed and disputeOpen are always false on creation.
   */
  static create(params: {
    id: string;
    renterId: string;
    watchId: string;
    rentalPrice: number;
    createdAt: Date;
  }): Rental {
    if (!params.id) {
      throw new DomainError('Rental ID is required', 'INVALID_RENTAL_PARTIES');
    }
    if (!params.renterId) {
      throw new DomainError('Renter ID is required', 'INVALID_RENTAL_PARTIES');
    }
    if (!params.watchId) {
      throw new DomainError('Watch ID is required', 'INVALID_RENTAL_PARTIES');
    }
    if (params.rentalPrice <= 0 || !Number.isFinite(params.rentalPrice)) {
      throw new DomainError(
        'Rental price must be a positive finite number',
        'INVALID_VALUATION',
      );
    }

    return new Rental({
      id: params.id,
      renterId: params.renterId,
      watchId: params.watchId,
      rentalPrice: params.rentalPrice,
      escrowStatus: EscrowStatus.NOT_STARTED,
      externalPaymentIntentId: null,
      externalTransferId: null,
      returnConfirmed: false,
      disputeOpen: false,
      createdAt: params.createdAt,
      version: 0,
    });
  }

  /**
   * Restore a rental from persistence. Validates all invariants
   * that must hold regardless of how the data was stored.
   * Does NOT enforce FSM transitions — the persisted state is
   * the current state, not a transition target.
   */
  static restore(params: {
    id: string;
    renterId: string;
    watchId: string;
    rentalPrice: number;
    escrowStatus: string;
    externalPaymentIntentId: string | null;
    externalTransferId?: string | null;
    returnConfirmed: boolean;
    disputeOpen: boolean;
    createdAt: Date;
    version: number;
  }): Rental {
    if (!params.id) {
      throw new DomainError('Rental ID is required', 'INVALID_RENTAL_PARTIES');
    }
    if (!params.renterId) {
      throw new DomainError('Renter ID is required', 'INVALID_RENTAL_PARTIES');
    }
    if (!params.watchId) {
      throw new DomainError('Watch ID is required', 'INVALID_RENTAL_PARTIES');
    }
    if (params.rentalPrice <= 0 || !Number.isFinite(params.rentalPrice)) {
      throw new DomainError(
        'Rental price must be a positive finite number',
        'INVALID_VALUATION',
      );
    }

    // Validate escrowStatus is a known enum value (boundary check for persistence data)
    if (!ALL_ESCROW_STATUSES.has(params.escrowStatus)) {
      throw new DomainError(
        `Unknown escrow status from persistence: ${params.escrowStatus}`,
        'INVALID_ESCROW_TRANSITION',
      );
    }
    const escrowStatus = params.escrowStatus as EscrowStatus;

    // Validate structural consistency of persisted state
    if (
      escrowStatus === EscrowStatus.NOT_STARTED &&
      params.externalPaymentIntentId !== null
    ) {
      throw new DomainError(
        'NOT_STARTED rental cannot have an external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    if (
      escrowStatus !== EscrowStatus.NOT_STARTED &&
      !params.externalPaymentIntentId
    ) {
      throw new DomainError(
        'Active rental must have an external payment intent',
        'INVALID_PAYMENT_TRANSITION',
      );
    }

    if (params.returnConfirmed) {
      const capturedOrLater =
        escrowStatus === EscrowStatus.EXTERNAL_PAYMENT_CAPTURED ||
        escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER ||
        escrowStatus === EscrowStatus.DISPUTED ||
        escrowStatus === EscrowStatus.REFUNDED;
      if (!capturedOrLater) {
        throw new DomainError(
          'returnConfirmed cannot be true before payment capture',
          'INVALID_STATE_TRANSITION',
        );
      }
    }

    if (params.disputeOpen && escrowStatus !== EscrowStatus.DISPUTED) {
      throw new DomainError(
        'disputeOpen can only be true when escrowStatus is DISPUTED',
        'INVALID_STATE_TRANSITION',
      );
    }

    if (!Number.isInteger(params.version) || params.version < 0) {
      throw new DomainError(
        'Version must be a non-negative integer',
        'VERSION_CONFLICT',
      );
    }

    return new Rental({
      id: params.id,
      renterId: params.renterId,
      watchId: params.watchId,
      rentalPrice: params.rentalPrice,
      escrowStatus,
      externalPaymentIntentId: params.externalPaymentIntentId,
      externalTransferId: params.externalTransferId ?? null,
      returnConfirmed: params.returnConfirmed,
      disputeOpen: params.disputeOpen,
      createdAt: params.createdAt,
      version: params.version,
    });
  }

  get escrowStatus(): EscrowStatus {
    return this._escrowStatus;
  }

  get externalPaymentIntentId(): string | null {
    return this._externalPaymentIntentId;
  }

  get externalTransferId(): string | null {
    return this._externalTransferId;
  }

  get returnConfirmed(): boolean {
    return this._returnConfirmed;
  }

  get disputeOpen(): boolean {
    return this._disputeOpen;
  }

  get version(): number {
    return this._version;
  }

  private bumpVersion(): void {
    this._version += 1;
  }

  isTerminal(): boolean {
    return (
      this._escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER ||
      this._escrowStatus === EscrowStatus.REFUNDED
    );
  }

  confirmReturn(): void {
    if (this._returnConfirmed) {
      throw new DomainError(
        'Return has already been confirmed',
        'INVALID_STATE_TRANSITION',
      );
    }
    if (
      this._escrowStatus !== EscrowStatus.EXTERNAL_PAYMENT_CAPTURED &&
      this._escrowStatus !== EscrowStatus.DISPUTED
    ) {
      throw new DomainError(
        'Return can only be confirmed after payment is captured',
        'INVALID_STATE_TRANSITION',
      );
    }
    this._returnConfirmed = true;
    this.bumpVersion();
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
    this.bumpVersion();
  }

  startExternalPayment(sessionId: string): void {
    if (!sessionId) {
      throw new DomainError(
        'External payment session ID is required',
        'INVALID_PAYMENT_TRANSITION',
      );
    }
    if (this._externalPaymentIntentId !== null) {
      throw new DomainError(
        'External payment intent has already been assigned',
        'DUPLICATE_REQUEST',
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

  releaseFunds(externalTransferId?: string): void {
    if (!this._returnConfirmed) {
      throw new DomainError(
        'Cannot release funds without confirmed return',
        'RETURN_NOT_CONFIRMED',
      );
    }
    if (this._disputeOpen) {
      throw new DomainError(
        'Cannot release funds while dispute is open',
        'DISPUTE_LOCK',
      );
    }
    this.transitionTo(EscrowStatus.FUNDS_RELEASED_TO_OWNER);
    if (externalTransferId) {
      this._externalTransferId = externalTransferId;
    }
  }

  markDisputed(): void {
    this.transitionTo(EscrowStatus.DISPUTED);
    this._disputeOpen = true;
  }

  resolveDispute(): void {
    if (!this._disputeOpen) {
      throw new DomainError(
        'No open dispute to resolve',
        'INVALID_STATE_TRANSITION',
      );
    }
    this._disputeOpen = false;
    this.bumpVersion();
  }

  /**
   * After a dispute is resolved in the owner's favor, restore the rental
   * to CAPTURED state so the normal release flow can proceed.
   * Requires: dispute must already be resolved (disputeOpen === false),
   * and current status must be DISPUTED.
   */
  restoreToCaptured(): void {
    if (this._disputeOpen) {
      throw new DomainError(
        'Cannot restore to captured while dispute is still open',
        'DISPUTE_LOCK',
      );
    }
    this.transitionTo(EscrowStatus.EXTERNAL_PAYMENT_CAPTURED);
  }

  markRefunded(): void {
    if (this._escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER) {
      throw new DomainError(
        'Cannot refund after funds have been released to owner',
        'INVALID_ESCROW_TRANSITION',
      );
    }
    this.transitionTo(EscrowStatus.REFUNDED);
  }
}
