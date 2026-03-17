import {
  ProviderSnapshotAdapter,
  ProviderPaymentSnapshot,
  ProviderConnectedAccountSnapshot,
} from '../../domain/reconciliation/ProviderSnapshot';

/**
 * Stub adapter for non-production environments.
 * Returns null for all lookups — reconciliation will detect
 * ORPHAN_INTERNAL_RECORD for any rental with a payment reference.
 */
export class StubProviderSnapshotAdapter implements ProviderSnapshotAdapter {
  async fetchPaymentSnapshot(_paymentIntentId: string): Promise<ProviderPaymentSnapshot | null> {
    return null;
  }

  async fetchConnectedAccountSnapshot(_connectedAccountId: string): Promise<ProviderConnectedAccountSnapshot | null> {
    return null;
  }
}
