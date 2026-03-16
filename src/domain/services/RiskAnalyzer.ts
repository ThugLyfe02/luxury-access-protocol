import { DomainError } from '../errors/DomainError';
import { User } from '../entities/User';
import { Watch } from '../entities/Watch';
import { KycProfile } from '../entities/KycProfile';
import { InsurancePolicy } from '../entities/InsurancePolicy';
import { ManualReviewCase } from '../entities/ManualReviewCase';
import { ReviewSeverity } from '../enums/ReviewSeverity';

const VELOCITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RENTALS_PER_WINDOW = 3;
const COLLUSION_CHARGEBACK_THRESHOLD = 1;
const ANOMALOUS_VALUE_MULTIPLIER = 5;

export interface RiskSignal {
  code: string;
  severity: ReviewSeverity;
  message: string;
}

export class RiskAnalyzer {
  static analyzeRentalRisk(params: {
    renter: User;
    watch: Watch;
    rentalPrice: number;
    kyc: KycProfile | null;
    insurance: InsurancePolicy | null;
    recentRentalTimestamps: Date[];
    now: Date;
  }): { signals: RiskSignal[]; requiresManualReview: boolean } {
    const signals: RiskSignal[] = [];

    // 1. KYC check
    if (!params.kyc || !params.kyc.isVerified(params.now)) {
      signals.push({
        code: 'KYC_REQUIRED',
        severity: ReviewSeverity.CRITICAL,
        message: 'Renter does not have verified KYC',
      });
    }

    // 2. KYC risk flags (PEP / sanctions)
    if (params.kyc && params.kyc.hasRiskFlags()) {
      signals.push({
        code: 'HIGH_RISK_TRANSACTION',
        severity: ReviewSeverity.CRITICAL,
        message: 'Renter KYC has PEP or sanctions flags',
      });
    }

    // 3. Insurance coverage check
    if (params.watch.isHighValue()) {
      if (!params.insurance || !params.insurance.isActive(params.now)) {
        signals.push({
          code: 'INSURANCE_INACTIVE',
          severity: ReviewSeverity.HIGH,
          message: 'High-value watch has no active insurance policy',
        });
      } else if (!params.insurance.coversValue(params.watch.marketValue)) {
        signals.push({
          code: 'INSURANCE_POLICY_INVALID',
          severity: ReviewSeverity.HIGH,
          message: 'Insurance coverage is insufficient for watch market value',
        });
      }
    }

    // 4. Velocity check
    const windowStart = new Date(params.now.getTime() - VELOCITY_WINDOW_MS);
    const recentCount = params.recentRentalTimestamps.filter(
      (t) => t >= windowStart,
    ).length;
    if (recentCount >= MAX_RENTALS_PER_WINDOW) {
      signals.push({
        code: 'SUSPICIOUS_VELOCITY',
        severity: ReviewSeverity.HIGH,
        message: `Renter has ${recentCount} rentals in the last 24 hours`,
      });
    }

    // 5. Collusion risk (chargeback history on same owner's watches)
    if (params.renter.chargebacksCount >= COLLUSION_CHARGEBACK_THRESHOLD) {
      signals.push({
        code: 'COLLUSION_RISK',
        severity: ReviewSeverity.MEDIUM,
        message: 'Renter has prior chargebacks indicating potential collusion',
      });
    }

    // 6. Anomalous transaction value
    if (params.rentalPrice > params.watch.marketValue * ANOMALOUS_VALUE_MULTIPLIER) {
      signals.push({
        code: 'ANOMALOUS_TRANSACTION',
        severity: ReviewSeverity.CRITICAL,
        message: 'Rental price is anomalously high relative to watch market value',
      });
    }

    // 7. High-risk user flag
    if (params.renter.isHighRisk()) {
      signals.push({
        code: 'HIGH_RISK_TRANSACTION',
        severity: ReviewSeverity.HIGH,
        message: 'Renter is flagged as high-risk',
      });
    }

    const requiresManualReview = signals.some(
      (s) =>
        s.severity === ReviewSeverity.CRITICAL ||
        s.severity === ReviewSeverity.HIGH,
    );

    return { signals, requiresManualReview };
  }

  static createReviewCase(
    rentalId: string,
    signals: RiskSignal[],
    now: Date,
  ): ManualReviewCase | null {
    if (signals.length === 0) {
      return null;
    }

    const highestSeverity = RiskAnalyzer.highestSeverity(signals);
    const combinedReason = signals.map((s) => s.message).join('; ');

    return new ManualReviewCase({
      id: crypto.randomUUID(),
      rentalId,
      severity: highestSeverity,
      reason: combinedReason,
      createdAt: now,
    });
  }

  private static highestSeverity(signals: RiskSignal[]): ReviewSeverity {
    const order: ReadonlyMap<ReviewSeverity, number> = new Map([
      [ReviewSeverity.LOW, 0],
      [ReviewSeverity.MEDIUM, 1],
      [ReviewSeverity.HIGH, 2],
      [ReviewSeverity.CRITICAL, 3],
    ]);

    let highest = ReviewSeverity.LOW;
    for (const signal of signals) {
      if ((order.get(signal.severity) ?? 0) > (order.get(highest) ?? 0)) {
        highest = signal.severity;
      }
    }
    return highest;
  }
}
