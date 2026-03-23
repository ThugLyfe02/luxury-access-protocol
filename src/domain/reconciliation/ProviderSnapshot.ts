/**
 * Normalized provider truth for a payment intent / checkout session.
 *
 * This is the adapter boundary between raw provider SDK responses
 * and the reconciliation engine. The engine only sees this shape.
 */
export interface ProviderPaymentSnapshot {
  readonly paymentIntentId: string;
  readonly status: ProviderPaymentStatus;
  readonly amountCaptured: number;
  readonly amountRefunded: number;
  readonly currency: string;
  readonly disputeOpen: boolean;
  readonly disputeStatus: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly fetchedAt: Date;
}

export type ProviderPaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded'
  | 'unknown';

/**
 * Normalized provider truth for a connected account.
 */
export interface ProviderConnectedAccountSnapshot {
  readonly connectedAccountId: string;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly fetchedAt: Date;
}

/**
 * Normalized provider truth for a transfer to a connected account.
 */
export type ProviderTransferStatus = 'pending' | 'paid' | 'failed' | 'reversed' | 'canceled' | 'unknown';

export interface ProviderTransferSnapshot {
  readonly transferId: string;
  readonly status: ProviderTransferStatus;
  readonly amount: number;
  readonly currency: string;
  readonly destination: string;
  readonly reversed: boolean;
  readonly metadata: Readonly<Record<string, string>>;
  readonly fetchedAt: Date;
}

/**
 * Adapter interface for fetching provider truth.
 *
 * Implementations wrap the raw provider SDK and normalize responses
 * into reconciliation-friendly shapes. The reconciliation engine
 * depends on this interface, not on raw Stripe types.
 */
export interface ProviderSnapshotAdapter {
  fetchPaymentSnapshot(paymentIntentId: string): Promise<ProviderPaymentSnapshot | null>;
  fetchConnectedAccountSnapshot(connectedAccountId: string): Promise<ProviderConnectedAccountSnapshot | null>;
  fetchTransferSnapshot(transferId: string): Promise<ProviderTransferSnapshot | null>;
}
