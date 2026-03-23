/**
 * Adversarial test factories and helpers.
 *
 * Provides deterministic entity creation, hostile scenario builders,
 * and payment provider spy/stub helpers for Phase F tests.
 */
import { vi } from 'vitest';
import { Rental } from '../../../src/domain/entities/Rental';
import { Watch } from '../../../src/domain/entities/Watch';
import { User } from '../../../src/domain/entities/User';
import { InsuranceClaim } from '../../../src/domain/entities/InsuranceClaim';
import { InsurancePolicy } from '../../../src/domain/entities/InsurancePolicy';
import { ManualReviewCase } from '../../../src/domain/entities/ManualReviewCase';
import { KycProfile } from '../../../src/domain/entities/KycProfile';
import { EscrowStatus } from '../../../src/domain/enums/EscrowStatus';
import { VerificationStatus } from '../../../src/domain/enums/VerificationStatus';
import { MarketplaceRole } from '../../../src/domain/enums/MarketplaceRole';
import { ReviewSeverity } from '../../../src/domain/enums/ReviewSeverity';
import { NormalizedEventType, PaymentProviderEvent } from '../../../src/application/payments/PaymentProviderEvent';
import { PaymentProvider } from '../../../src/domain/interfaces/PaymentProvider';
import { DomainError } from '../../../src/domain/errors/DomainError';

// ---------- Entity Factories ----------

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function resetIdCounter(): void {
  counter = 0;
}

export function makeRental(overrides?: Partial<{
  id: string;
  renterId: string;
  watchId: string;
  rentalPrice: number;
  createdAt: Date;
}>): Rental {
  return Rental.create({
    id: overrides?.id ?? nextId('rental'),
    renterId: overrides?.renterId ?? 'renter-1',
    watchId: overrides?.watchId ?? 'watch-1',
    rentalPrice: overrides?.rentalPrice ?? 500,
    createdAt: overrides?.createdAt ?? new Date('2025-01-01'),
  });
}

/**
 * Create a rental in CAPTURED state (ready for release gate testing).
 */
export function makeCapturedRental(overrides?: Partial<{
  id: string;
  renterId: string;
  watchId: string;
  rentalPrice: number;
  returnConfirmed: boolean;
}>): Rental {
  const rental = makeRental({
    id: overrides?.id,
    renterId: overrides?.renterId,
    watchId: overrides?.watchId,
    rentalPrice: overrides?.rentalPrice,
  });
  rental.startExternalPayment(`pi_${rental.id}`);
  rental.markPaymentAuthorized();
  rental.markPaymentCaptured();
  if (overrides?.returnConfirmed !== false) {
    rental.confirmReturn();
  }
  return rental;
}

export function makeWatch(overrides?: Partial<{
  id: string;
  ownerId: string;
  marketValue: number;
  verificationStatus: VerificationStatus;
}>): Watch {
  return Watch.create({
    id: overrides?.id ?? nextId('watch'),
    ownerId: overrides?.ownerId ?? 'owner-1',
    marketValue: overrides?.marketValue ?? 3000,
    verificationStatus: overrides?.verificationStatus ?? VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: new Date('2025-01-01'),
  });
}

export function makeUser(overrides?: Partial<{
  id: string;
  role: MarketplaceRole;
  trustScore: number;
  chargebacksCount: number;
  disputesCount: number;
}>): User {
  return User.create({
    id: overrides?.id ?? nextId('user'),
    role: overrides?.role ?? MarketplaceRole.RENTER,
    trustScore: overrides?.trustScore ?? 85,
    disputesCount: overrides?.disputesCount ?? 0,
    chargebacksCount: overrides?.chargebacksCount ?? 0,
    createdAt: new Date('2024-01-01'),
  });
}

export function makeOwner(id?: string): User {
  return makeUser({ id: id ?? 'owner-1', role: MarketplaceRole.OWNER });
}

export function makeVerifiedKyc(userId: string): KycProfile {
  const kyc = KycProfile.create({
    userId,
    providerReference: 'ref-1',
    createdAt: new Date('2024-01-01'),
  });
  kyc.submitForVerification();
  kyc.markVerified(
    new Date('2024-06-01'),
    new Date('2026-06-01'),
  );
  return kyc;
}

export function makeClaim(overrides?: Partial<{
  id: string;
  policyId: string;
  rentalId: string;
  watchId: string;
  claimAmount: number;
  reason: string;
}>): InsuranceClaim {
  return InsuranceClaim.create({
    id: overrides?.id ?? nextId('claim'),
    policyId: overrides?.policyId ?? 'policy-1',
    rentalId: overrides?.rentalId ?? 'rental-1',
    watchId: overrides?.watchId ?? 'watch-1',
    claimAmount: overrides?.claimAmount ?? 1000,
    reason: overrides?.reason ?? 'Scratch on case',
    filedAt: new Date('2025-01-15'),
  });
}

export function makePolicy(overrides?: Partial<{
  id: string;
  watchId: string;
}>): InsurancePolicy {
  return InsurancePolicy.create({
    id: overrides?.id ?? nextId('policy'),
    watchId: overrides?.watchId ?? 'watch-1',
    providerId: 'provider-1',
    coverageAmount: 10000,
    deductible: 500,
    premiumPerRental: 50,
    effectiveFrom: new Date('2024-01-01'),
    effectiveTo: new Date('2026-12-31'),
    createdAt: new Date('2024-01-01'),
  });
}

export function makeBlockingReviewCase(rentalId: string): ManualReviewCase {
  return ManualReviewCase.create({
    id: nextId('review'),
    rentalId,
    severity: ReviewSeverity.HIGH,
    reason: 'Suspicious activity',
    createdAt: new Date('2025-01-10'),
    freezeTargets: [{ entityType: 'Rental', entityId: rentalId }],
  });
}

// ---------- Webhook Event Factory ----------

export function makeWebhookEvent(
  type: NormalizedEventType,
  paymentIntentId: string,
  eventId?: string,
): { event: PaymentProviderEvent; stripeEventId: string } {
  const id = eventId ?? nextId('evt');
  return {
    stripeEventId: id,
    event: {
      externalEventId: id,
      type,
      externalPaymentIntentId: paymentIntentId,
      externalCheckoutSessionId: null,
      connectedAccountId: null,
      refundAmountCents: null,
      disputeWonByPlatform: null,
      rawReferenceId: paymentIntentId,
      occurredAt: new Date(),
    },
  };
}

// ---------- Payment Provider Stubs ----------

export function makeStubPaymentProvider(): PaymentProvider {
  return {
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/test' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test', paymentIntentId: 'pi_test' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
  };
}

export function makeFailingTransferProvider(): PaymentProvider {
  return {
    ...makeStubPaymentProvider(),
    transferToConnectedAccount: vi.fn().mockRejectedValue(
      new Error('Stripe Connect transfer failed: insufficient funds'),
    ),
  };
}

// ---------- Domain Error Assertion ----------

export async function expectDomainError(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<DomainError> {
  try {
    await promise;
    throw new Error(`Expected DomainError with code ${expectedCode} but promise resolved`);
  } catch (err) {
    if (!(err instanceof DomainError)) {
      throw new Error(
        `Expected DomainError with code ${expectedCode} but got: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (err.code !== expectedCode) {
      throw new Error(
        `Expected DomainError code ${expectedCode} but got ${err.code}: ${err.message}`,
      );
    }
    return err;
  }
}
