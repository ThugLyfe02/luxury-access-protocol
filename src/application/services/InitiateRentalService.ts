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
import {
  PlatformExposureEngine,
  ExposureSnapshot,
  ExposureConfig,
} from '../../domain/services/PlatformExposureEngine';
import { ReviewFreezePolicy } from '../../domain/services/ReviewFreezePolicy';
import { Actor } from '../auth/Actor';
import { AuthorizationGuard } from '../auth/AuthorizationGuard';
import { AuditLog } from '../audit/AuditLog';

export interface InitiateRentalResult {
  rental: Rental;
  riskSignals: RiskSignal[];
  reviewCase: ManualReviewCase | null;
  blocked: boolean;
}

export class InitiateRentalService {
  private readonly paymentProvider: PaymentProvider;
  private readonly auditLog: AuditLog;
  private readonly processedIdempotencyKeys = new Set<string>();

  constructor(paymentProvider: PaymentProvider, auditLog: AuditLog) {
    this.paymentProvider = paymentProvider;
    this.auditLog = auditLog;
  }

  async execute(
    actor: Actor,
    input: {
      idempotencyKey?: string;
      renter: User;
      watch: Watch;
      rentalPrice: number;
      city: string;
      zipCode: string;
      renterKyc: KycProfile | null;
      watchInsurance: InsurancePolicy | null;
      renterTier: RenterTier;
      recentRentalTimestamps: Date[];
      exposureSnapshot: ExposureSnapshot;
      exposureConfig: ExposureConfig;
      renterFreezeCases: ManualReviewCase[];
      watchFreezeCases: ManualReviewCase[];
      now: Date;
    },
  ): Promise<InitiateRentalResult> {
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
      exposureSnapshot,
      exposureConfig,
      renterFreezeCases,
      watchFreezeCases,
      now,
    } = input;

    const correlationId = input.idempotencyKey ?? crypto.randomUUID();

    try {
      // 0a. Caller must be an authenticated user acting as themselves
      AuthorizationGuard.requireSelf(actor, renter.id);

      // 0b. Caller must not be the watch owner (self-rental authz boundary)
      AuthorizationGuard.rejectSelfOwned(actor, watch.ownerId);

      // 0c. Idempotency check — reject duplicate requests
      if (input.idempotencyKey) {
        if (this.processedIdempotencyKeys.has(input.idempotencyKey)) {
          throw new DomainError(
            'Duplicate rental initiation request',
            'DUPLICATE_REQUEST',
          );
        }
      }

      // 0d. Freeze checks — hard stop if renter or watch is frozen
      ReviewFreezePolicy.assertUserNotFrozen(renter.id, renterFreezeCases);
      ReviewFreezePolicy.assertWatchNotFrozen(watch.id, watchFreezeCases);

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

      // 8. Platform exposure / capital protection — hard stop
      const proposedInsuranceCoverage =
        watchInsurance && watchInsurance.isActive(now)
          ? watchInsurance.netCoverage()
          : 0;

      PlatformExposureEngine.assertRentalWithinExposureLimits(
        exposureConfig,
        exposureSnapshot,
        {
          watchMarketValue: watch.marketValue,
          insuranceCoverage: proposedInsuranceCoverage,
        },
      );

      // 9. Risk analysis — advisory, may create review case
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

      // 10. If risk analysis requires manual review with CRITICAL signals, block
      const hasCriticalSignal = riskSignals.some(
        (s) => s.severity === ReviewSeverity.CRITICAL,
      );
      if (hasCriticalSignal) {
        throw new DomainError(
          'Rental blocked by critical risk signals pending manual review',
          'REVIEW_REQUIRED',
        );
      }

      // 11. Create rental entity
      const rental = Rental.create({
        id: crypto.randomUUID(),
        renterId: renter.id,
        watchId: watch.id,
        rentalPrice,
        createdAt: now,
      });

      // 12. Create review case if risk analysis flagged it (non-blocking HIGH/MEDIUM/LOW)
      const reviewCase = requiresManualReview
        ? RiskAnalyzer.createReviewCase(rental.id, riskSignals, now, [
            { entityType: 'Rental', entityId: rental.id },
            { entityType: 'User', entityId: renter.id },
            { entityType: 'Watch', entityId: watch.id },
          ])
        : null;

      // 13. External checkout session via payment provider
      const { sessionId } = await this.paymentProvider.createCheckoutSession(
        rental.id,
        rentalPrice,
      );

      // 14. Transition to awaiting external payment
      rental.startExternalPayment(sessionId);

      // 15. Record idempotency key after successful creation
      if (input.idempotencyKey) {
        this.processedIdempotencyKeys.add(input.idempotencyKey);
      }

      // 16. Audit: successful rental initiation
      this.auditLog.record({
        actor,
        entityType: 'Rental',
        entityId: rental.id,
        action: 'initiate_rental',
        outcome: 'success',
        afterState: rental.escrowStatus,
        correlationId,
        externalRef: sessionId,
      });

      if (reviewCase) {
        this.auditLog.record({
          actor,
          entityType: 'ManualReviewCase',
          entityId: reviewCase.id,
          action: 'create_review_case',
          outcome: 'success',
          afterState: reviewCase.severity,
          correlationId,
        });
      }

      return {
        rental,
        riskSignals,
        reviewCase,
        blocked: false,
      };
    } catch (error) {
      if (error instanceof DomainError) {
        this.auditLog.recordBlocked({
          actor,
          entityType: 'Rental',
          entityId: `renter:${renter.id}:watch:${watch.id}`,
          action: 'initiate_rental',
          error,
          correlationId,
        });
      }
      throw error;
    }
  }
}
