import { PoolClient } from 'pg';
import { Watch } from '../../domain/entities/Watch';
import { WatchRepository } from '../../domain/interfaces/WatchRepository';
import { DomainError } from '../../domain/errors/DomainError';
import { getPool } from '../db/connection';

/**
 * PostgreSQL-backed WatchRepository.
 *
 * Same OCC strategy as PostgresUserRepository: version is tracked
 * at the infrastructure level since Watch domain entity has no version field.
 */
export class PostgresWatchRepository implements WatchRepository {
  private readonly loadedVersions = new Map<string, number>();
  private readonly txClient: PoolClient | null;

  constructor(client?: PoolClient) {
    this.txClient = client ?? null;
  }

  private query(text: string, values: unknown[]) {
    const executor = this.txClient ?? getPool();
    return executor.query(text, values);
  }

  private hydrateRow(row: Record<string, unknown>): Watch {
    this.loadedVersions.set(row.id as string, row.version as number);

    return Watch.restore({
      id: row.id as string,
      ownerId: row.owner_id as string,
      marketValue: parseFloat(row.market_value as string),
      verificationStatus: (row.verification_status as string).toUpperCase(),
      createdAt: new Date(row.created_at as string),
    });
  }

  async findById(id: string): Promise<Watch | null> {
    const { rows } = await this.query(
      `SELECT id, owner_id, market_value, verification_status,
              is_available, created_at, version
       FROM watches WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) return null;
    return this.hydrateRow(rows[0]);
  }

  async findByOwnerId(ownerId: string): Promise<Watch[]> {
    const { rows } = await this.query(
      `SELECT id, owner_id, market_value, verification_status,
              is_available, created_at, version
       FROM watches WHERE owner_id = $1`,
      [ownerId],
    );

    return rows.map((row: Record<string, unknown>) => this.hydrateRow(row));
  }

  async save(watch: Watch): Promise<void> {
    const loadedVersion = this.loadedVersions.get(watch.id);

    if (loadedVersion === undefined) {
      // New entity — INSERT
      await this.query(
        `INSERT INTO watches (id, owner_id, market_value, verification_status,
                              is_available, created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 0)`,
        [
          watch.id,
          watch.ownerId,
          watch.marketValue,
          watch.verificationStatus,
          true,
          watch.createdAt,
        ],
      );
      this.loadedVersions.set(watch.id, 0);
    } else {
      // Existing entity — UPDATE with optimistic concurrency
      const nextVersion = loadedVersion + 1;
      const { rowCount } = await this.query(
        `UPDATE watches
         SET owner_id = $1, market_value = $2, verification_status = $3,
             updated_at = now(), version = $4
         WHERE id = $5 AND version = $6`,
        [
          watch.ownerId,
          watch.marketValue,
          watch.verificationStatus,
          nextVersion,
          watch.id,
          loadedVersion,
        ],
      );

      if (rowCount === 0) {
        throw new DomainError(
          `Watch version conflict: expected version ${loadedVersion}`,
          'VERSION_CONFLICT',
        );
      }

      this.loadedVersions.set(watch.id, nextVersion);
    }
  }
}
