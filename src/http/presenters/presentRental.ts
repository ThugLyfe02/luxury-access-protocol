import { Rental } from '../../domain/entities/Rental';

/**
 * External-facing rental representation.
 * Only exposes fields safe for API consumers.
 * No internal bookkeeping (version, internal IDs) leaks.
 */
export interface RentalView {
  id: string;
  renterId: string;
  watchId: string;
  rentalPrice: number;
  escrowStatus: string;
  externalPaymentIntentId: string | null;
  returnConfirmed: boolean;
  disputeOpen: boolean;
  createdAt: string;
}

export function presentRental(rental: Rental): RentalView {
  return {
    id: rental.id,
    renterId: rental.renterId,
    watchId: rental.watchId,
    rentalPrice: rental.rentalPrice,
    escrowStatus: rental.escrowStatus,
    externalPaymentIntentId: rental.externalPaymentIntentId,
    returnConfirmed: rental.returnConfirmed,
    disputeOpen: rental.disputeOpen,
    createdAt: rental.createdAt.toISOString(),
  };
}
