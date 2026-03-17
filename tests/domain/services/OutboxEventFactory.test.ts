import { describe, it, expect } from 'vitest';
import { OutboxEventFactory } from '../../../src/domain/services/OutboxEventFactory';

describe('OutboxEventFactory', () => {
  it('creates checkout session event with correct topic and dedup key', () => {
    const event = OutboxEventFactory.checkoutSession({
      rentalId: 'rental-1',
      renterId: 'renter-1',
      watchId: 'watch-1',
      ownerId: 'owner-1',
      amount: 500,
      currency: 'usd',
    });

    expect(event.topic).toBe('payment.checkout_session.create');
    expect(event.aggregateType).toBe('Rental');
    expect(event.aggregateId).toBe('rental-1');
    expect(event.dedupKey).toBe('checkout:rental-1');
    expect(event.payload.rentalId).toBe('rental-1');
    expect(event.payload.amount).toBe(500);
    expect(event.status).toBe('PENDING');
  });

  it('creates capture payment event', () => {
    const event = OutboxEventFactory.capturePayment({
      rentalId: 'rental-1',
      paymentIntentId: 'pi_123',
    });

    expect(event.topic).toBe('payment.capture');
    expect(event.dedupKey).toBe('capture:rental-1');
    expect(event.payload.paymentIntentId).toBe('pi_123');
  });

  it('creates refund payment event', () => {
    const event = OutboxEventFactory.refundPayment({
      rentalId: 'rental-1',
      paymentIntentId: 'pi_123',
    });

    expect(event.topic).toBe('payment.refund');
    expect(event.dedupKey).toBe('refund:rental-1');
  });

  it('creates transfer to owner event', () => {
    const event = OutboxEventFactory.transferToOwner({
      rentalId: 'rental-1',
      amount: 400,
      connectedAccountId: 'acct_123',
    });

    expect(event.topic).toBe('payment.transfer_to_owner');
    expect(event.dedupKey).toBe('transfer:rental-1');
    expect(event.payload.amount).toBe(400);
  });

  it('creates connected account event', () => {
    const event = OutboxEventFactory.createConnectedAccount({
      ownerId: 'owner-1',
      email: 'owner@test.com',
      country: 'US',
    });

    expect(event.topic).toBe('payment.connected_account.create');
    expect(event.aggregateType).toBe('User');
    expect(event.aggregateId).toBe('owner-1');
    expect(event.dedupKey).toBe('connected_account:owner-1');
  });

  it('creates onboarding link event', () => {
    const event = OutboxEventFactory.createOnboardingLink({
      connectedAccountId: 'acct_123',
      returnUrl: 'https://example.com/return',
      refreshUrl: 'https://example.com/refresh',
    });

    expect(event.topic).toBe('payment.onboarding_link.create');
    expect(event.aggregateType).toBe('User');
    expect(event.payload.returnUrl).toBe('https://example.com/return');
  });

  it('generates unique IDs for each event', () => {
    const e1 = OutboxEventFactory.capturePayment({ rentalId: 'r1', paymentIntentId: 'pi_1' });
    const e2 = OutboxEventFactory.capturePayment({ rentalId: 'r2', paymentIntentId: 'pi_2' });
    expect(e1.id).not.toBe(e2.id);
  });
});
