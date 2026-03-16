import { EscrowStatus } from '../../domain/enums/EscrowStatus';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { User } from '../../domain/entities/User';
import { Watch } from '../../domain/entities/Watch';
import { Rental } from '../../domain/entities/Rental';
import { RegulatoryGuardrails } from '../../domain/services/RegulatoryGuardrails';
import { RiskPolicy } from '../../domain/services/RiskPolicy';
import { UnitEconomicsGuard } from '../../domain/services/UnitEconomicsGuard';

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

    // 1. Anti-custody firewall
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'initiate_rental',
      { rentalPrice },
    );

    // 2. Risk policy gate (includes self-rental, high-risk, verification, ceiling)
    RiskPolicy.ensureCanInitiateRental(renter, watch, rentalPrice);

    // 3. Unit economics viability (platform gross = 20% of rental charge)
    UnitEconomicsGuard.assertRentalEconomicsViable(
      rentalPrice,
      watch.marketValue,
      rentalPrice * 0.20,
    );

    // 4. Create rental entity
    const rental = new Rental({
      id: crypto.randomUUID(),
      renterId: renter.id,
      watchId: watch.id,
      rentalPrice,
      escrowStatus: EscrowStatus.NOT_STARTED,
      externalPaymentIntentId: null,
      createdAt: new Date(),
    });

    // 5. External checkout session
    const { sessionId } = await this.paymentProvider.createCheckoutSession(
      rental.id,
      rentalPrice,
    );

    // 6. Transition to awaiting payment
    rental.startExternalPayment(sessionId);

    return rental;
  }
}
