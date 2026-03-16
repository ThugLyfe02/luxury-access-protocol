import { DomainError } from '../../domain/errors/DomainError';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { User } from '../../domain/entities/User';
import { Watch } from '../../domain/entities/Watch';
import { Rental } from '../../domain/entities/Rental';
import { KycProfile } from '../../domain/entities/KycProfile';
import { InsurancePolicy } from '../../domain/entities/InsurancePolicy';
import { ManualReviewCase } from '../../domain/entities/ManualReviewCase';
import { RenterTier } from '../../domain/enums/RenterTier';
import { ReviewSeverity } from '../../domain/enums/ReviewSeverity';
import { RegulatoryGuardrails } from '../../domain/services/RegulatoryGuardrails';
import { CompliancePolicy } from '../../domain/services/CompliancePolicy';
import { RiskPolicy } from '../../domain/services/RiskPolicy';
import { UnitEconomicsGuard } from '../../domain/services/UnitEconomicsGuard';
import { RiskAnalyzer, RiskSignal } from '../../domain/services/RiskAnalyzer';
import { TierEngine } from '../../domain/services/TierEngine';

export interface InitiateRentalResult {
  rental: Rental;
  riskSignals: RiskSignal[];
  reviewCase: ManualReviewCase | null;
  blocked: boolean;
}

export class InitiateRentalService {
  private readonly paymentProvider: PaymentProvider;

  constructor(paymentProvider: PaymentProvider) {
    this.paymentProvider = paymentProvider;
  }

  async execute(input: {
    renter: User;
    watch: Watch;
    rentalPrice: number;
    city: string;
    zipCode: string;
    renterKyc: KycProfile | null;
    watchInsurance: InsurancePolicy | null;
    renterTier: RenterTier;
    recentRentalTimestamps: Date[];
    now: Date;
  }): Promise<InitiateRentalResult> {
    const {
      renter,
      watch,
      rentalPrice,
      city,
      zipCode,
      renterKyc,
      watchInsurance,
      renterTier,
      recentRentalTimestamps,
      now,
    } = input;

    // 1. Anti-custody firewall — hard stop
    RegulatoryGuardrails.assertNoCustodyPrincipalMutation(
      'initiate_rental',
      { rentalPrice },
    );

    // 2. Geographic containment — hard stop
    CompliancePolicy.ensureCityActive(city);
    CompliancePolicy.ensureZipMatchesCity(zipCode, city);

    // 3. KYC verification — hard stop
    RiskPolicy.ensureKycVerified(renterKyc, now);

    // 4. Core risk policy (self-rental, high-risk, verification, role ceiling) — hard stop
    RiskPolicy.ensureCanInitiateRental(renter, watch, rentalPrice);

    // 5. Insurance coverage for high-value watches — hard stop
    RiskPolicy.ensureInsuranceActive(watchInsurance, watch, now);

    // 6. Tier-based value ceiling — hard stop
    TierEngine.ensureTierAllowsValue(renterTier, watch.marketValue);

    // 7. Unit economics viability — hard stop
    UnitEconomicsGuard.assertRentalEconomicsViable(
      rentalPrice,
      watch.marketValue,
      rentalPrice * 0.20,
    );

    // 8. Risk analysis — advisory, may create review case
    const { signals: riskSignals, requiresManualReview } =
      RiskAnalyzer.analyzeRentalRisk({
        renter,
        watch,
        rentalPrice,
        kyc: renterKyc,
        insurance: watchInsurance,
        recentRentalTimestamps,
        now,
      });

    // 9. If risk analysis requires manual review with CRITICAL signals, block
    const hasCriticalSignal = riskSignals.some(
      (s) => s.severity === ReviewSeverity.CRITICAL,
    );
    if (hasCriticalSignal) {
      throw new DomainError(
        'Rental blocked by critical risk signals pending manual review',
        'REVIEW_REQUIRED',
      );
    }

    // 10. Create rental entity
    const rental = Rental.create({
      id: crypto.randomUUID(),
      renterId: renter.id,
      watchId: watch.id,
      rentalPrice,
      createdAt: now,
    });

    // 11. Create review case if risk analysis flagged it (non-blocking HIGH/MEDIUM/LOW)
    const reviewCase = requiresManualReview
      ? RiskAnalyzer.createReviewCase(rental.id, riskSignals, now)
      : null;

    // 12. External checkout session via payment provider
    const { sessionId } = await this.paymentProvider.createCheckoutSession(
      rental.id,
      rentalPrice,
    );

    // 13. Transition to awaiting external payment
    rental.startExternalPayment(sessionId);

    return {
      rental,
      riskSignals,
      reviewCase,
      blocked: false,
    };
  }
}
