import { assertEnv, readEnv } from '../config/assertEnv';

/**
 * Stripe configuration.
 *
 * Required environment variables:
 *   STRIPE_SECRET_KEY         — Stripe API secret key (sk_live_… or sk_test_…)
 *   STRIPE_WEBHOOK_SECRET     — Webhook endpoint signing secret (whsec_…)
 *
 * Optional (with defaults):
 *   STRIPE_CONNECT_COUNTRY    — Default country for Connected Accounts (default: 'US')
 *   STRIPE_PLATFORM_FEE_BPS  — Platform fee in basis points (default: 200 = 2.00%)
 *   STRIPE_SUCCESS_URL        — Checkout success redirect URL
 *   STRIPE_CANCEL_URL         — Checkout cancel redirect URL
 *
 * All required values fail-fast on startup if missing.
 * No secrets are hardcoded. No silent fallback to dummy values.
 */
export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly connectCountry: string;
  readonly platformFeeBps: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

let cached: StripeConfig | null = null;

export function loadStripeConfig(): StripeConfig {
  if (cached) return cached;

  const secretKey = assertEnv('STRIPE_SECRET_KEY');
  const webhookSecret = assertEnv('STRIPE_WEBHOOK_SECRET');
  const connectCountry = readEnv('STRIPE_CONNECT_COUNTRY', 'US');
  const platformFeeBpsRaw = readEnv('STRIPE_PLATFORM_FEE_BPS', '200');
  const successUrl = readEnv('STRIPE_SUCCESS_URL', 'https://localhost:3000/checkout/success');
  const cancelUrl = readEnv('STRIPE_CANCEL_URL', 'https://localhost:3000/checkout/cancel');

  const platformFeeBps = parseInt(platformFeeBpsRaw, 10);
  if (!Number.isFinite(platformFeeBps) || platformFeeBps < 0) {
    throw new Error(
      `STRIPE_PLATFORM_FEE_BPS must be a non-negative integer, got: ${platformFeeBpsRaw}`,
    );
  }

  cached = {
    secretKey,
    webhookSecret,
    connectCountry,
    platformFeeBps,
    successUrl,
    cancelUrl,
  };

  return cached;
}

/**
 * Clear cached config. Only used in tests.
 */
export function resetStripeConfigCache(): void {
  cached = null;
}
