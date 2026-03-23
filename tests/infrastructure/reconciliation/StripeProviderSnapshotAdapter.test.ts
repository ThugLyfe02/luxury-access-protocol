import { describe, it, expect, vi } from 'vitest';
import { StripeProviderSnapshotAdapter } from '../../../src/infrastructure/reconciliation/StripeProviderSnapshotAdapter';
import { ProviderError } from '../../../src/domain/errors/ProviderError';
import Stripe from 'stripe';

/**
 * Tests for StripeProviderSnapshotAdapter.
 * Uses Stripe SDK mocks with fixture objects matching real API response shapes.
 */

function createMockStripe() {
  return {
    paymentIntents: {
      retrieve: vi.fn(),
    },
    accounts: {
      retrieve: vi.fn(),
    },
  } as unknown as Stripe;
}

describe('StripeProviderSnapshotAdapter', () => {
  describe('fetchPaymentSnapshot', () => {
    it('maps a succeeded payment intent with captured charge', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValueOnce({
        id: 'pi_test_123',
        status: 'succeeded',
        currency: 'usd',
        metadata: { rentalId: 'rental-1', ownerId: 'owner-1' },
        latest_charge: {
          id: 'ch_123',
          amount_captured: 50000,
          amount_refunded: 0,
          disputed: false,
        },
      } as any);

      const snapshot = await adapter.fetchPaymentSnapshot('pi_test_123');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.paymentIntentId).toBe('pi_test_123');
      expect(snapshot!.status).toBe('succeeded');
      expect(snapshot!.amountCaptured).toBe(50000);
      expect(snapshot!.amountRefunded).toBe(0);
      expect(snapshot!.currency).toBe('usd');
      expect(snapshot!.disputeOpen).toBe(false);
      expect(snapshot!.metadata).toEqual({ rentalId: 'rental-1', ownerId: 'owner-1' });
      expect(snapshot!.fetchedAt).toBeInstanceOf(Date);
    });

    it('maps requires_capture status correctly', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValueOnce({
        id: 'pi_auth',
        status: 'requires_capture',
        currency: 'usd',
        metadata: {},
        latest_charge: null,
      } as any);

      const snapshot = await adapter.fetchPaymentSnapshot('pi_auth');

      expect(snapshot!.status).toBe('requires_capture');
      expect(snapshot!.amountCaptured).toBe(0);
    });

    it('detects disputed charge', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValueOnce({
        id: 'pi_disputed',
        status: 'succeeded',
        currency: 'usd',
        metadata: {},
        latest_charge: {
          id: 'ch_456',
          amount_captured: 50000,
          amount_refunded: 0,
          disputed: true,
        },
      } as any);

      const snapshot = await adapter.fetchPaymentSnapshot('pi_disputed');

      expect(snapshot!.disputeOpen).toBe(true);
    });

    it('maps unknown status to unknown', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValueOnce({
        id: 'pi_weird',
        status: 'some_new_status',
        currency: 'usd',
        metadata: {},
        latest_charge: null,
      } as any);

      const snapshot = await adapter.fetchPaymentSnapshot('pi_weird');

      expect(snapshot!.status).toBe('unknown');
    });

    it('returns null for Stripe 404 (not found)', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      const notFoundError = new Stripe.errors.StripeInvalidRequestError({
        message: 'No such payment_intent: pi_nonexistent',
        type: 'invalid_request_error',
      });
      (notFoundError as any).statusCode = 404;

      vi.mocked(stripe.paymentIntents.retrieve).mockRejectedValueOnce(notFoundError);

      const snapshot = await adapter.fetchPaymentSnapshot('pi_nonexistent');
      expect(snapshot).toBeNull();
    });

    it('throws ProviderError for non-404 Stripe errors', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.paymentIntents.retrieve).mockRejectedValueOnce(
        new Error('Connection refused'),
      );

      await expect(adapter.fetchPaymentSnapshot('pi_test')).rejects.toThrow(ProviderError);
    });

    it('maps refunded charge correctly', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.paymentIntents.retrieve).mockResolvedValueOnce({
        id: 'pi_refunded',
        status: 'succeeded',
        currency: 'usd',
        metadata: {},
        latest_charge: {
          id: 'ch_789',
          amount_captured: 50000,
          amount_refunded: 50000,
          disputed: false,
        },
      } as any);

      const snapshot = await adapter.fetchPaymentSnapshot('pi_refunded');

      expect(snapshot!.amountCaptured).toBe(50000);
      expect(snapshot!.amountRefunded).toBe(50000);
    });
  });

  describe('fetchConnectedAccountSnapshot', () => {
    it('maps a fully onboarded account', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.accounts.retrieve).mockResolvedValueOnce({
        id: 'acct_test_123',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      } as any);

      const snapshot = await adapter.fetchConnectedAccountSnapshot('acct_test_123');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.connectedAccountId).toBe('acct_test_123');
      expect(snapshot!.chargesEnabled).toBe(true);
      expect(snapshot!.payoutsEnabled).toBe(true);
      expect(snapshot!.detailsSubmitted).toBe(true);
      expect(snapshot!.fetchedAt).toBeInstanceOf(Date);
    });

    it('maps a partially onboarded account', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.accounts.retrieve).mockResolvedValueOnce({
        id: 'acct_partial',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      } as any);

      const snapshot = await adapter.fetchConnectedAccountSnapshot('acct_partial');

      expect(snapshot!.chargesEnabled).toBe(false);
      expect(snapshot!.payoutsEnabled).toBe(false);
      expect(snapshot!.detailsSubmitted).toBe(false);
    });

    it('returns null for Stripe 404', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      const notFoundError = new Stripe.errors.StripeInvalidRequestError({
        message: 'No such account: acct_nonexistent',
        type: 'invalid_request_error',
      });
      (notFoundError as any).statusCode = 404;

      vi.mocked(stripe.accounts.retrieve).mockRejectedValueOnce(notFoundError);

      const snapshot = await adapter.fetchConnectedAccountSnapshot('acct_nonexistent');
      expect(snapshot).toBeNull();
    });

    it('throws ProviderError for non-404 errors', async () => {
      const stripe = createMockStripe();
      const adapter = new StripeProviderSnapshotAdapter(stripe);

      vi.mocked(stripe.accounts.retrieve).mockRejectedValueOnce(
        new Error('Service unavailable'),
      );

      await expect(adapter.fetchConnectedAccountSnapshot('acct_test'))
        .rejects.toThrow(ProviderError);
    });
  });
});
