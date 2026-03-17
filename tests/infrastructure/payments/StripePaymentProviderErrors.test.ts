import { describe, it, expect, vi } from 'vitest';
import { StripePaymentProvider } from '../../../src/infrastructure/payments/StripePaymentProvider';
import { ProviderError } from '../../../src/domain/errors/ProviderError';
import { StripeConfig } from '../../../src/infrastructure/payments/stripeConfig';
import Stripe from 'stripe';

/**
 * Tests for deterministic error classification in StripePaymentProvider.
 *
 * Verifies that each Stripe error subclass maps to the correct ProviderErrorCode,
 * and that the ambiguous/retryable flags are set correctly based on whether
 * the operation is state-changing.
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

function createProvider(): StripePaymentProvider {
  return new StripePaymentProvider(makeConfig());
}

describe('StripePaymentProvider error classification', () => {
  describe('capturePayment (state-changing)', () => {
    it('classifies StripeCardError as PROVIDER_CARD_DECLINED', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeCardError({
          message: 'Your card was declined',
          type: 'card_error',
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_CARD_DECLINED');
        expect(pe.retryable).toBe(false);
        expect(pe.ambiguous).toBe(false);
        expect(pe.isStateChanging).toBe(true);
      }
    });

    it('classifies StripeConnectionError as PROVIDER_NETWORK_TIMEOUT (ambiguous) for state-changing', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({
          message: 'Connection timed out',
          type: 'connection_error' as any,
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_NETWORK_TIMEOUT');
        expect(pe.retryable).toBe(true);
        expect(pe.ambiguous).toBe(true);
        expect(pe.isStateChanging).toBe(true);
      }
    });

    it('classifies StripeRateLimitError as PROVIDER_RATE_LIMITED', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeRateLimitError({
          message: 'Too many requests',
          type: 'rate_limit_error' as any,
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_RATE_LIMITED');
        expect(pe.retryable).toBe(true);
        expect(pe.ambiguous).toBe(false);
      }
    });

    it('classifies StripeAuthenticationError as PROVIDER_AUTHENTICATION_FAILED', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeAuthenticationError({
          message: 'Invalid API key',
          type: 'authentication_error' as any,
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_AUTHENTICATION_FAILED');
        expect(pe.retryable).toBe(false);
        expect(pe.ambiguous).toBe(false);
      }
    });

    it('classifies StripeInvalidRequestError with "No such" as PROVIDER_RESOURCE_NOT_FOUND', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          message: 'No such payment_intent: pi_xxx',
          type: 'invalid_request_error',
        }),
      );

      try {
        await provider.capturePayment('pi_xxx');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_RESOURCE_NOT_FOUND');
        expect(pe.retryable).toBe(false);
      }
    });

    it('classifies StripeInvalidRequestError with idempotency message as PROVIDER_IDEMPOTENCY_CONFLICT', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          message: 'Keys for idempotent requests can only be used with the same parameters',
          type: 'invalid_request_error',
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_IDEMPOTENCY_CONFLICT');
        expect(pe.retryable).toBe(false);
      }
    });

    it('classifies other StripeInvalidRequestError as PROVIDER_INVALID_REQUEST', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          message: 'Amount must be positive',
          type: 'invalid_request_error',
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_INVALID_REQUEST');
        expect(pe.retryable).toBe(false);
      }
    });

    it('classifies StripeAPIError as PROVIDER_UNAVAILABLE', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Stripe.errors.StripeAPIError({
          message: 'Internal server error',
          type: 'api_error',
        }),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_UNAVAILABLE');
        expect(pe.retryable).toBe(true);
        expect(pe.ambiguous).toBe(false);
      }
    });

    it('classifies ETIMEDOUT error as PROVIDER_NETWORK_TIMEOUT for state-changing', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Error('connect ETIMEDOUT 1.2.3.4:443'),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_NETWORK_TIMEOUT');
        expect(pe.ambiguous).toBe(true);
      }
    });

    it('classifies unknown error as PROVIDER_UNKNOWN', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.paymentIntents, 'capture').mockRejectedValueOnce(
        new Error('Something completely unexpected'),
      );

      try {
        await provider.capturePayment('pi_test');
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_UNKNOWN');
        expect(pe.retryable).toBe(true);
      }
    });
  });

  describe('createOnboardingLink (non-state-changing)', () => {
    it('classifies StripeConnectionError as PROVIDER_UNAVAILABLE (not ambiguous) for non-state-changing', async () => {
      const provider = createProvider();
      const stripe = provider.getStripeInstance();

      vi.spyOn(stripe.accountLinks, 'create').mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({
          message: 'Connection refused',
          type: 'connection_error' as any,
        }),
      );

      try {
        await provider.createOnboardingLink({
          connectedAccountId: 'acct_test',
          returnUrl: 'https://example.com/return',
          refreshUrl: 'https://example.com/refresh',
        });
        expect.unreachable();
      } catch (error) {
        const pe = error as ProviderError;
        expect(pe.code).toBe('PROVIDER_UNAVAILABLE');
        expect(pe.ambiguous).toBe(false);
        expect(pe.isStateChanging).toBe(false);
      }
    });
  });
});
