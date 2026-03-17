import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadStripeConfig, resetStripeConfigCache } from '../../../src/infrastructure/payments/stripeConfig';

describe('Stripe config hardening', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetStripeConfigCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetStripeConfigCache();
  });

  it('rejects sk_test_ key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_abc';

    expect(() => loadStripeConfig()).toThrow('sk_test_ key detected in production');
  });

  it('rejects sk_live_ key in non-production', () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_abc';

    expect(() => loadStripeConfig()).toThrow('sk_live_ key detected in non-production');
  });

  it('rejects non-sk_live_ key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'rk_live_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_abc';

    expect(() => loadStripeConfig()).toThrow('must start with sk_live_ in production');
  });

  it('rejects webhook secret without whsec_ prefix', () => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'invalid_secret';

    expect(() => loadStripeConfig()).toThrow('must start with whsec_');
  });

  it('accepts sk_test_ key in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_abc';

    const config = loadStripeConfig();
    expect(config.secretKey).toBe('sk_test_abc123');
  });

  it('accepts sk_test_ key in test environment', () => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_abc';

    const config = loadStripeConfig();
    expect(config.secretKey).toBe('sk_test_abc123');
  });

  it('accepts sk_live_ key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_abc';

    const config = loadStripeConfig();
    expect(config.secretKey).toBe('sk_live_abc123');
  });
});
