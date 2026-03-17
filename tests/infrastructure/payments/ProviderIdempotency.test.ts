import { describe, it, expect, vi } from 'vitest';
import { StripePaymentProvider } from '../../../src/infrastructure/payments/StripePaymentProvider';
import { StripeConfig } from '../../../src/infrastructure/payments/stripeConfig';

/**
 * Tests that all state-changing provider operations include idempotency keys.
 */

function makeConfig(): StripeConfig {
  return {
    secretKey: 'sk_test_fake_key_for_unit_tests',
    webhookSecret: 'whsec_test_secret',
    connectCountry: 'US',
    platformFeeBps: 200,
    successUrl: 'https://test.example.com/success',
    cancelUrl: 'https://test.example.com/cancel',
  };
}

describe('Provider idempotency keys', () => {
  it('capturePayment sends idempotencyKey: capture_{piId}', async () => {
    const provider = new StripePaymentProvider(makeConfig());
    const stripe = provider.getStripeInstance();

    const captureSpy = vi.spyOn(stripe.paymentIntents, 'capture').mockResolvedValueOnce({
      id: 'pi_123',
      status: 'succeeded',
    } as any);

    await provider.capturePayment('pi_123');

    expect(captureSpy).toHaveBeenCalledWith(
      'pi_123',
      {},
      expect.objectContaining({ idempotencyKey: 'capture_pi_123' }),
    );
  });

  it('refundPayment sends idempotencyKey: refund_{piId}', async () => {
    const provider = new StripePaymentProvider(makeConfig());
    const stripe = provider.getStripeInstance();

    const refundSpy = vi.spyOn(stripe.refunds, 'create').mockResolvedValueOnce({
      id: 're_123',
      status: 'succeeded',
    } as any);

    await provider.refundPayment('pi_456');

    expect(refundSpy).toHaveBeenCalledWith(
      { payment_intent: 'pi_456' },
      expect.objectContaining({ idempotencyKey: 'refund_pi_456' }),
    );
  });

  it('createCheckoutSession sends idempotencyKey: checkout_{rentalId}', async () => {
    const provider = new StripePaymentProvider(makeConfig());
    const stripe = provider.getStripeInstance();

    const sessionSpy = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValueOnce({
      id: 'cs_123',
      payment_intent: 'pi_789',
    } as any);

    await provider.createCheckoutSession({
      rentalId: 'rental-42',
      renterId: 'renter-1',
      watchId: 'watch-1',
      ownerId: 'owner-1',
      amount: 500,
      currency: 'usd',
    });

    expect(sessionSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ idempotencyKey: 'checkout_rental-42' }),
    );
  });

  it('createConnectedAccount sends idempotencyKey: account_{ownerId}', async () => {
    const provider = new StripePaymentProvider(makeConfig());
    const stripe = provider.getStripeInstance();

    const accountSpy = vi.spyOn(stripe.accounts, 'create').mockResolvedValueOnce({
      id: 'acct_123',
    } as any);

    await provider.createConnectedAccount({
      ownerId: 'owner-99',
      email: 'owner@test.com',
      country: 'US',
    });

    expect(accountSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ idempotencyKey: 'account_owner-99' }),
    );
  });

  it('transferToConnectedAccount sends idempotencyKey: transfer_{rentalId}', async () => {
    const provider = new StripePaymentProvider(makeConfig());
    const stripe = provider.getStripeInstance();

    const transferSpy = vi.spyOn(stripe.transfers, 'create').mockResolvedValueOnce({
      id: 'tr_123',
    } as any);

    await provider.transferToConnectedAccount({
      amount: 450,
      connectedAccountId: 'acct_123',
      rentalId: 'rental-42',
    });

    expect(transferSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ idempotencyKey: 'transfer_rental-42' }),
    );
  });
});
