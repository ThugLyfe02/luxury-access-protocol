import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';

export class StripePaymentProvider implements PaymentProvider {
  async createCheckoutSession(
    _rentalId: string,
    _amount: number,
  ): Promise<{ sessionId: string }> {
    throw new Error('Not implemented');
  }

  async authorizePayment(
    _intentId: string,
  ): Promise<{ authorized: boolean }> {
    throw new Error('Not implemented');
  }

  async capturePayment(
    _intentId: string,
  ): Promise<{ captured: boolean }> {
    throw new Error('Not implemented');
  }

  async refundPayment(
    _intentId: string,
  ): Promise<{ refunded: boolean }> {
    throw new Error('Not implemented');
  }

  async transferToConnectedAccount(
    _params: {
      amount: number;
      connectedAccountId: string;
      rentalId: string;
    },
  ): Promise<{ transferId: string }> {
    throw new Error('Not implemented');
  }
}
