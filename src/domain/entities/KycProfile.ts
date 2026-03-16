import { DomainError } from '../errors/DomainError';
import { KycStatus } from '../enums/KycStatus';

const VALID_TRANSITIONS: ReadonlyMap<KycStatus, ReadonlySet<KycStatus>> =
  new Map<KycStatus, ReadonlySet<KycStatus>>([
    [KycStatus.NOT_STARTED, new Set([KycStatus.PENDING])],
    [KycStatus.PENDING, new Set([KycStatus.VERIFIED, KycStatus.REJECTED])],
    [KycStatus.VERIFIED, new Set([KycStatus.EXPIRED])],
    [KycStatus.REJECTED, new Set([KycStatus.PENDING])],
    [KycStatus.EXPIRED, new Set([KycStatus.PENDING])],
  ]);

const ALL_KYC_STATUSES: ReadonlySet<string> = new Set(
  Object.values(KycStatus),
);

export class KycProfile {
  readonly userId: string;
  readonly providerReference: string | null;
  readonly createdAt: Date;
  private _status: KycStatus;
  private _verifiedAt: Date | null;
  private _expiresAt: Date | null;
  private _rejectionReason: string | null;
  private _pepFlagged: boolean;
  private _sanctionsFlagged: boolean;

  private constructor(params: {
    userId: string;
    status: KycStatus;
    providerReference: string | null;
    verifiedAt: Date | null;
    expiresAt: Date | null;
    rejectionReason: string | null;
    pepFlagged: boolean;
    sanctionsFlagged: boolean;
    createdAt: Date;
  }) {
    this.userId = params.userId;
    this._status = params.status;
    this.providerReference = params.providerReference;
    this._verifiedAt = params.verifiedAt;
    this._expiresAt = params.expiresAt;
    this._rejectionReason = params.rejectionReason;
    this._pepFlagged = params.pepFlagged;
    this._sanctionsFlagged = params.sanctionsFlagged;
    this.createdAt = params.createdAt;
  }

  private static validateStructuralConsistency(
    status: KycStatus,
    verifiedAt: Date | null,
    expiresAt: Date | null,
  ): void {
    if (status === KycStatus.VERIFIED) {
      if (verifiedAt === null) {
        throw new DomainError(
          'VERIFIED KYC profile must have a verifiedAt date',
          'KYC_REQUIRED',
        );
      }
      if (expiresAt === null) {
        throw new DomainError(
          'VERIFIED KYC profile must have an expiresAt date',
          'KYC_REQUIRED',
        );
      }
      if (expiresAt <= verifiedAt) {
        throw new DomainError(
          'Expiration must be after verification date',
          'KYC_REQUIRED',
        );
      }
    }
  }

  static create(params: {
    userId: string;
    providerReference: string | null;
    createdAt: Date;
  }): KycProfile {
    if (!params.userId) {
      throw new DomainError(
        'User ID is required for KYC profile',
        'KYC_REQUIRED',
      );
    }

    return new KycProfile({
      userId: params.userId,
      status: KycStatus.NOT_STARTED,
      providerReference: params.providerReference,
      verifiedAt: null,
      expiresAt: null,
      rejectionReason: null,
      pepFlagged: false,
      sanctionsFlagged: false,
      createdAt: params.createdAt,
    });
  }

  static restore(params: {
    userId: string;
    status: string;
    providerReference: string | null;
    verifiedAt: Date | null;
    expiresAt: Date | null;
    rejectionReason: string | null;
    pepFlagged: boolean;
    sanctionsFlagged: boolean;
    createdAt: Date;
  }): KycProfile {
    if (!params.userId) {
      throw new DomainError(
        'User ID is required for KYC profile',
        'KYC_REQUIRED',
      );
    }

    if (!ALL_KYC_STATUSES.has(params.status)) {
      throw new DomainError(
        `Unknown KYC status from persistence: ${params.status}`,
        'INVALID_STATE_TRANSITION',
      );
    }

    const status = params.status as KycStatus;
    KycProfile.validateStructuralConsistency(
      status,
      params.verifiedAt,
      params.expiresAt,
    );

    return new KycProfile({
      ...params,
      status,
    });
  }

  get status(): KycStatus {
    return this._status;
  }

  get verifiedAt(): Date | null {
    return this._verifiedAt;
  }

  get expiresAt(): Date | null {
    return this._expiresAt;
  }

  get rejectionReason(): string | null {
    return this._rejectionReason;
  }

  get pepFlagged(): boolean {
    return this._pepFlagged;
  }

  get sanctionsFlagged(): boolean {
    return this._sanctionsFlagged;
  }

  isVerified(asOf: Date): boolean {
    if (this._status !== KycStatus.VERIFIED) {
      return false;
    }
    if (this._expiresAt !== null && asOf >= this._expiresAt) {
      return false;
    }
    if (this._pepFlagged || this._sanctionsFlagged) {
      return false;
    }
    return true;
  }

  hasRiskFlags(): boolean {
    return this._pepFlagged || this._sanctionsFlagged;
  }

  private transitionTo(nextStatus: KycStatus): void {
    const allowed = VALID_TRANSITIONS.get(this._status);
    if (!allowed || !allowed.has(nextStatus)) {
      throw new DomainError(
        `Invalid KYC transition from ${this._status} to ${nextStatus}`,
        'INVALID_STATE_TRANSITION',
      );
    }
    this._status = nextStatus;
  }

  submitForVerification(): void {
    this.transitionTo(KycStatus.PENDING);
  }

  markVerified(verifiedAt: Date, expiresAt: Date): void {
    if (!verifiedAt) {
      throw new DomainError(
        'Verification date is required',
        'KYC_REQUIRED',
      );
    }
    if (!expiresAt) {
      throw new DomainError(
        'Expiration date is required',
        'KYC_REQUIRED',
      );
    }
    if (expiresAt <= verifiedAt) {
      throw new DomainError(
        'Expiration must be after verification date',
        'KYC_REQUIRED',
      );
    }
    this.transitionTo(KycStatus.VERIFIED);
    this._verifiedAt = verifiedAt;
    this._expiresAt = expiresAt;
    this._rejectionReason = null;
  }

  markRejected(reason: string): void {
    if (!reason) {
      throw new DomainError(
        'Rejection reason is required',
        'KYC_REQUIRED',
      );
    }
    this.transitionTo(KycStatus.REJECTED);
    this._rejectionReason = reason;
  }

  markExpired(): void {
    this.transitionTo(KycStatus.EXPIRED);
  }

  flagPep(): void {
    this._pepFlagged = true;
  }

  flagSanctions(): void {
    this._sanctionsFlagged = true;
  }
}
