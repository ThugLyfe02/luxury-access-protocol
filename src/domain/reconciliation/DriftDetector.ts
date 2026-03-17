import { DriftType } from '../enums/DriftType';
import { EscrowStatus } from '../enums/EscrowStatus';
import { InternalPaymentSnapshot } from './InternalSnapshot';
import { ProviderPaymentSnapshot, ProviderPaymentStatus, ProviderTransferSnapshot } from './ProviderSnapshot';

export interface DetectedDrift {
  readonly driftType: DriftType;
  readonly internalSnapshot: Record<string, unknown>;
  readonly providerSnapshot: Record<string, unknown>;
  readonly providerObjectIds: string[];
}

/**
 * Deterministic drift detection between internal and provider snapshots.
 *
 * Compares normalized representations and emits zero or more findings.
 * No mutations — pure detection logic.
 */
export class DriftDetector {
  /**
   * Compare internal rental state against provider payment truth.
   * Returns all detected drifts (there may be multiple for one rental).
   */
  static detectPaymentDrift(
    internal: InternalPaymentSnapshot,
    provider: ProviderPaymentSnapshot | null,
  ): DetectedDrift[] {
    const drifts: DetectedDrift[] = [];
    const internalSnap = { ...internal } as Record<string, unknown>;

    // Case: internal has payment reference but provider returns null
    if (!provider && internal.externalPaymentIntentId && internal.escrowStatus !== EscrowStatus.NOT_STARTED) {
      drifts.push({
        driftType: DriftType.ORPHAN_INTERNAL_RECORD,
        internalSnapshot: internalSnap,
        providerSnapshot: { paymentIntentId: internal.externalPaymentIntentId, status: 'not_found' },
        providerObjectIds: [internal.externalPaymentIntentId],
      });
      return drifts;
    }

    // Case: no provider data and no payment intent — nothing to compare
    if (!provider) return drifts;

    const providerSnap = { ...provider } as unknown as Record<string, unknown>;

    // Internal authorized but provider has no matching authorized/captured state
    if (
      internal.escrowStatus === EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED &&
      !isProviderAuthorizedOrBeyond(provider.status)
    ) {
      if (provider.status === 'canceled' || provider.status === 'unknown') {
        drifts.push({
          driftType: DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING,
          internalSnapshot: internalSnap,
          providerSnapshot: providerSnap,
          providerObjectIds: [provider.paymentIntentId],
        });
      }
    }

    // Provider captured but internal not yet captured
    if (
      isProviderCaptured(provider) &&
      internal.escrowStatus === EscrowStatus.EXTERNAL_PAYMENT_AUTHORIZED
    ) {
      drifts.push({
        driftType: DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [provider.paymentIntentId],
      });
    }

    // Internal released but provider amount doesn't match expectations
    if (
      internal.escrowStatus === EscrowStatus.FUNDS_RELEASED_TO_OWNER &&
      !isProviderCaptured(provider) &&
      provider.status !== 'succeeded'
    ) {
      drifts.push({
        driftType: DriftType.INTERNAL_RELEASED_BUT_PROVIDER_NOT_RELEASED,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [provider.paymentIntentId],
      });
    }

    // Provider dispute open but internal clean
    if (provider.disputeOpen && !internal.disputeOpen && internal.escrowStatus !== EscrowStatus.DISPUTED) {
      drifts.push({
        driftType: DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [provider.paymentIntentId],
      });
    }

    // Internal dispute open but provider says closed
    if (internal.disputeOpen && !provider.disputeOpen && internal.escrowStatus === EscrowStatus.DISPUTED) {
      drifts.push({
        driftType: DriftType.INTERNAL_DISPUTE_OPEN_BUT_PROVIDER_CLOSED,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [provider.paymentIntentId],
      });
    }

    // Refund state mismatch
    if (
      internal.escrowStatus === EscrowStatus.REFUNDED &&
      provider.amountRefunded === 0 &&
      provider.status !== 'canceled'
    ) {
      drifts.push({
        driftType: DriftType.REFUND_STATE_MISMATCH,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [provider.paymentIntentId],
      });
    }

    if (
      internal.escrowStatus !== EscrowStatus.REFUNDED &&
      provider.amountRefunded > 0 &&
      !internal.disputeOpen
    ) {
      drifts.push({
        driftType: DriftType.REFUND_STATE_MISMATCH,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [provider.paymentIntentId],
      });
    }

    return drifts;
  }

  /**
   * Compare internal transfer state against provider transfer truth.
   * Only applicable when internal state is FUNDS_RELEASED_TO_OWNER and
   * a transfer ID is recorded.
   *
   * Returns drifts for:
   * - Transfer not found at provider (lost transfer)
   * - Transfer reversed at provider (clawback)
   */
  static detectTransferDrift(
    internal: InternalPaymentSnapshot,
    transferSnapshot: ProviderTransferSnapshot | null,
  ): DetectedDrift[] {
    const drifts: DetectedDrift[] = [];

    // Only check transfer truth when internal says funds were released with a transfer ID
    if (internal.escrowStatus !== EscrowStatus.FUNDS_RELEASED_TO_OWNER || !internal.externalTransferId) {
      return drifts;
    }

    const internalSnap = { ...internal } as Record<string, unknown>;

    // Transfer not found at provider
    if (!transferSnapshot) {
      drifts.push({
        driftType: DriftType.TRANSFER_NOT_FOUND_BUT_INTERNAL_RELEASED,
        internalSnapshot: internalSnap,
        providerSnapshot: { transferId: internal.externalTransferId, status: 'not_found' },
        providerObjectIds: [internal.externalTransferId],
      });
      return drifts;
    }

    const providerSnap = { ...transferSnapshot } as unknown as Record<string, unknown>;

    // Transfer reversed at provider
    if (transferSnapshot.reversed) {
      drifts.push({
        driftType: DriftType.TRANSFER_REVERSED_BUT_INTERNAL_RELEASED,
        internalSnapshot: internalSnap,
        providerSnapshot: providerSnap,
        providerObjectIds: [transferSnapshot.transferId],
      });
    }

    return drifts;
  }
}

function isProviderAuthorizedOrBeyond(status: ProviderPaymentStatus): boolean {
  return status === 'requires_capture' || status === 'succeeded';
}

function isProviderCaptured(provider: ProviderPaymentSnapshot): boolean {
  return provider.status === 'succeeded' && provider.amountCaptured > 0;
}
