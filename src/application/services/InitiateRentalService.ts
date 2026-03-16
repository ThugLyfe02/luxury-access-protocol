import { DomainError } from '../../domain/errors/DomainError';
import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { User } from '../../domain/entities/User';
import { Watch } from '../../domain/entities/Watch';
import { Rental } from '../../domain/entities/Rental';

export class InitiateRentalService {
  private readonly paymentProvider: PaymentProvider;

  constructor(paymentProvider: PaymentProvider) {
    this.paymentProvider = paymentProvider;
  }

  async execute(input: {
    renter: User;
    watch: Watch;
    rentalPrice: number;
  }): Promise<Rental> {
    const { renter, watch, rentalPrice } = input;

    if (renter.id === watch.ownerId) {
      throw new DomainError(
        'Renter cannot be the owner of the watch',
        'INVALID_RENTAL_PARTIES',
      );
    }

    if (rentalPrice <= 0) {
      throw new DomainError(
        'Rental price must be greater than zero',
        'INVALID_VALUATION',
      );
    }

    const rental = new Rental({
      id: crypto.randomUUID(),
      renterId: renter.id,
      watchId: watch.id,
      rentalPrice,
      escrowStatus: EscrowStatus.NOT_STARTED,
      externalPaymentIntentId: null,
      createdAt: new Date(),
    });

    const { sessionId } = await this.paymentProvider.createCheckoutSession(
      rental.id,
      rentalPrice,
    );

    rental.startExternalPayment(sessionId);

    return rental;
  }
}
