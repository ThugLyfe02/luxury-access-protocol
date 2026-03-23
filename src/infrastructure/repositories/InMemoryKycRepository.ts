import { KycProfile } from '../../domain/entities/KycProfile';
import { KycRepository } from '../../domain/interfaces/KycRepository';

interface KycRecord {
  readonly userId: string;
  readonly status: string;
  readonly providerReference: string | null;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly rejectionReason: string | null;
  readonly pepFlagged: boolean;
  readonly sanctionsFlagged: boolean;
  readonly createdAt: string;
}

function toRecord(profile: KycProfile): KycRecord {
  return {
    userId: profile.userId,
    status: profile.status,
    providerReference: profile.providerReference,
    verifiedAt: profile.verifiedAt?.toISOString() ?? null,
    expiresAt: profile.expiresAt?.toISOString() ?? null,
    rejectionReason: profile.rejectionReason,
    pepFlagged: profile.pepFlagged,
    sanctionsFlagged: profile.sanctionsFlagged,
    createdAt: profile.createdAt.toISOString(),
  };
}

function fromRecord(record: KycRecord): KycProfile {
  return KycProfile.restore({
    userId: record.userId,
    status: record.status,
    providerReference: record.providerReference,
    verifiedAt: record.verifiedAt !== null ? new Date(record.verifiedAt) : null,
    expiresAt: record.expiresAt !== null ? new Date(record.expiresAt) : null,
    rejectionReason: record.rejectionReason,
    pepFlagged: record.pepFlagged,
    sanctionsFlagged: record.sanctionsFlagged,
    createdAt: new Date(record.createdAt),
  });
}

export class InMemoryKycRepository implements KycRepository {
  private readonly store = new Map<string, KycRecord>();

  async findByUserId(userId: string): Promise<KycProfile | null> {
    const record = this.store.get(userId);
    if (!record) return null;
    return fromRecord(record);
  }

  async save(profile: KycProfile): Promise<void> {
    this.store.set(profile.userId, toRecord(profile));
  }
}
