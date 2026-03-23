/**
 * Persistence-backed idempotency store for write operations.
 *
 * Guarantees:
 * - Same key + same payload hash → return cached response (idempotent replay)
 * - Same key + different payload hash → reject (409 conflict)
 * - New key → proceed and record
 */

export interface IdempotencyRecord {
  key: string;
  payloadHash: string;
  responseStatus: number;
  responseBody: string;
  createdAt: Date;
}

export interface IdempotencyStore {
  find(key: string): Promise<IdempotencyRecord | null>;
  save(record: IdempotencyRecord): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();

  async find(key: string): Promise<IdempotencyRecord | null> {
    return this.store.get(key) ?? null;
  }

  async save(record: IdempotencyRecord): Promise<void> {
    this.store.set(record.key, record);
  }
}

/**
 * Compute a deterministic hash of a request payload for conflict detection.
 * Uses a simple JSON-based approach — sufficient for our use case.
 */
export function computePayloadHash(payload: unknown): string {
  const str = JSON.stringify(payload);
  // Simple FNV-1a-inspired hash — not crypto, just dedup
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
