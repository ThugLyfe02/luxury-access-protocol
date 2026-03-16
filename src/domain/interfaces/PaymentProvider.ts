export interface PaymentProvider {
  createCheckoutSession(
    rentalId: string,
    amount: number,
  ): Promise<{ sessionId: string }>;

  authorizePayment(intentId: string): Promise<{ authorized: boolean }>;

  capturePayment(intentId: string): Promise<{ captured: boolean }>;

  refundPayment(intentId: string): Promise<{ refunded: boolean }>;

  transferToConnectedAccount(params: {
    amount: number;
    connectedAccountId: string;
    rentalId: string;
  }): Promise<{ transferId: string }>;
}
