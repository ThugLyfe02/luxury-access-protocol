import { describe, it, expect, vi } from 'vitest';
import {
  CreateCheckoutSessionHandler,
  CapturePaymentHandler,
  RefundPaymentHandler,
  TransferToOwnerHandler,
  CreateConnectedAccountHandler,
  CreateOnboardingLinkHandler,
} from '../../../src/infrastructure/outbox/ProviderCommandHandlers';
import { OutboxEvent } from '../../../src/domain/entities/OutboxEvent';
import { PaymentProvider } from '../../../src/domain/interfaces/PaymentProvider';

const NOW = new Date('2025-06-01T00:00:00Z');

function makeProvider(): PaymentProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ sessionId: 'cs_test', paymentIntentId: 'pi_test' }),
    capturePayment: vi.fn().mockResolvedValue({ captured: true }),
    refundPayment: vi.fn().mockResolvedValue({ refunded: true }),
    transferToConnectedAccount: vi.fn().mockResolvedValue({ transferId: 'tr_test' }),
    createConnectedAccount: vi.fn().mockResolvedValue({ connectedAccountId: 'acct_test' }),
    createOnboardingLink: vi.fn().mockResolvedValue({ url: 'https://onboard.test' }),
  };
}

function makeEvent(topic: string, payload: Record<string, unknown>): OutboxEvent {
  return OutboxEvent.create({
    id: 'evt-1',
    topic: topic as any,
    aggregateType: 'Rental',
    aggregateId: 'rental-1',
    payload,
    dedupKey: `${topic}:rental-1`,
    createdAt: NOW,
  });
}

describe('ProviderCommandHandlers', () => {
  describe('CreateCheckoutSessionHandler', () => {
    it('calls provider with correct params and returns result', async () => {
      const provider = makeProvider();
      const handler = new CreateCheckoutSessionHandler(provider);
      const event = makeEvent('payment.checkout_session.create', {
        rentalId: 'r1', renterId: 'u1', watchId: 'w1', ownerId: 'o1', amount: 500, currency: 'usd',
      });

      const result = await handler.handle(event);

      expect(provider.createCheckoutSession).toHaveBeenCalledWith({
        rentalId: 'r1', renterId: 'u1', watchId: 'w1', ownerId: 'o1', amount: 500, currency: 'usd',
      });
      expect(result).toEqual({ sessionId: 'cs_test', paymentIntentId: 'pi_test' });
    });
  });

  describe('CapturePaymentHandler', () => {
    it('calls provider capturePayment', async () => {
      const provider = makeProvider();
      const handler = new CapturePaymentHandler(provider);
      const event = makeEvent('payment.capture', { paymentIntentId: 'pi_123' });

      const result = await handler.handle(event);

      expect(provider.capturePayment).toHaveBeenCalledWith('pi_123');
      expect(result).toEqual({ captured: true });
    });
  });

  describe('RefundPaymentHandler', () => {
    it('calls provider refundPayment', async () => {
      const provider = makeProvider();
      const handler = new RefundPaymentHandler(provider);
      const event = makeEvent('payment.refund', { paymentIntentId: 'pi_456' });

      const result = await handler.handle(event);

      expect(provider.refundPayment).toHaveBeenCalledWith('pi_456');
      expect(result).toEqual({ refunded: true });
    });
  });

  describe('TransferToOwnerHandler', () => {
    it('calls provider transferToConnectedAccount', async () => {
      const provider = makeProvider();
      const handler = new TransferToOwnerHandler(provider);
      const event = makeEvent('payment.transfer_to_owner', {
        amount: 400, connectedAccountId: 'acct_123', rentalId: 'r1',
      });

      const result = await handler.handle(event);

      expect(provider.transferToConnectedAccount).toHaveBeenCalledWith({
        amount: 400, connectedAccountId: 'acct_123', rentalId: 'r1',
      });
      expect(result).toEqual({ transferId: 'tr_test' });
    });
  });

  describe('CreateConnectedAccountHandler', () => {
    it('calls provider createConnectedAccount', async () => {
      const provider = makeProvider();
      const handler = new CreateConnectedAccountHandler(provider);
      const event = makeEvent('payment.connected_account.create', {
        ownerId: 'o1', email: 'o@test.com', country: 'US',
      });

      const result = await handler.handle(event);

      expect(provider.createConnectedAccount).toHaveBeenCalledWith({
        ownerId: 'o1', email: 'o@test.com', country: 'US',
      });
      expect(result).toEqual({ connectedAccountId: 'acct_test' });
    });
  });

  describe('CreateOnboardingLinkHandler', () => {
    it('calls provider createOnboardingLink', async () => {
      const provider = makeProvider();
      const handler = new CreateOnboardingLinkHandler(provider);
      const event = makeEvent('payment.onboarding_link.create', {
        connectedAccountId: 'acct_123', returnUrl: 'https://return', refreshUrl: 'https://refresh',
      });

      const result = await handler.handle(event);

      expect(provider.createOnboardingLink).toHaveBeenCalledWith({
        connectedAccountId: 'acct_123', returnUrl: 'https://return', refreshUrl: 'https://refresh',
      });
      expect(result).toEqual({ url: 'https://onboard.test' });
    });
  });
});
