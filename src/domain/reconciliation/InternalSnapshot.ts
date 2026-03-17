import { EscrowStatus } from '../enums/EscrowStatus';

/**
 * Normalized internal truth for a rental's payment lifecycle.
 */
export interface InternalPaymentSnapshot {
  readonly rentalId: string;
  readonly escrowStatus: EscrowStatus;
  readonly externalPaymentIntentId: string | null;
  readonly externalTransferId: string | null;
  readonly rentalPrice: number;
  readonly returnConfirmed: boolean;
  readonly disputeOpen: boolean;
  readonly renterId: string;
  readonly watchId: string;
  readonly version: number;
}

/**
 * Builder for creating normalized internal snapshots from Rental entities.
 */
export class InternalSnapshotBuilder {
  static fromRental(rental: {
    id: string;
    escrowStatus: EscrowStatus;
    externalPaymentIntentId: string | null;
    externalTransferId: string | null;
    rentalPrice: number;
    returnConfirmed: boolean;
    disputeOpen: boolean;
    renterId: string;
    watchId: string;
    version: number;
  }): InternalPaymentSnapshot {
    return {
      rentalId: rental.id,
      escrowStatus: rental.escrowStatus,
      externalPaymentIntentId: rental.externalPaymentIntentId,
      externalTransferId: rental.externalTransferId,
      rentalPrice: rental.rentalPrice,
      returnConfirmed: rental.returnConfirmed,
      disputeOpen: rental.disputeOpen,
      renterId: rental.renterId,
      watchId: rental.watchId,
      version: rental.version,
    };
  }
}
