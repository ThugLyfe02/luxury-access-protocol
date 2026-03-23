import { PoolClient } from 'pg';
import { User } from '../../domain/entities/User';
import { UserRepository } from '../../domain/interfaces/UserRepository';
import { DomainError } from '../../domain/errors/DomainError';
import { getPool } from '../db/connection';

/**
 * PostgreSQL-backed UserRepository.
 *
 * Optimistic concurrency: User domain entity does not carry a version field,
 * so the repository tracks the loaded version internally. On save, if the
 * stored version has changed since load, a VERSION_CONFLICT is thrown.
 *
 * Accepts an optional PoolClient to participate in an external transaction.
 */
export class PostgresUserRepository implements UserRepository {
  /**
   * Tracks the version that was loaded for each entity id during this
   * repository instance's lifetime. This allows the save method to
   * enforce optimistic concurrency even though User has no version field.
   */
  private readonly loadedVersions = new Map<string, number>();
  private readonly txClient: PoolClient | null;

  constructor(client?: PoolClient) {
    this.txClient = client ?? null;
  }

  private query(text: string, values: unknown[]) {
    const executor = this.txClient ?? getPool();
    return executor.query(text, values);
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.query(
      `SELECT id, role, trust_score, chargebacks_count, disputes_count,
              is_frozen, created_at, version
       FROM users WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    this.loadedVersions.set(row.id, row.version);

    return User.restore({
      id: row.id,
      role: row.role.toUpperCase(),
      trustScore: row.trust_score,
      disputesCount: row.disputes_count,
      chargebacksCount: row.chargebacks_count,
      createdAt: new Date(row.created_at),
    });
  }

  async save(user: User): Promise<void> {
    const loadedVersion = this.loadedVersions.get(user.id);

    if (loadedVersion === undefined) {
      // New entity — INSERT
      await this.query(
        `INSERT INTO users (id, role, trust_score, chargebacks_count, disputes_count,
                            is_frozen, created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 0)`,
        [
          user.id,
          user.role,
          user.trustScore,
          user.chargebacksCount,
          user.disputesCount,
          false,
          user.createdAt,
        ],
      );
      this.loadedVersions.set(user.id, 0);
    } else {
      // Existing entity — UPDATE with optimistic concurrency
      const nextVersion = loadedVersion + 1;
      const { rowCount } = await this.query(
        `UPDATE users
         SET role = $1, trust_score = $2, chargebacks_count = $3,
             disputes_count = $4, updated_at = now(), version = $5
         WHERE id = $6 AND version = $7`,
        [
          user.role,
          user.trustScore,
          user.chargebacksCount,
          user.disputesCount,
          nextVersion,
          user.id,
          loadedVersion,
        ],
      );

      if (rowCount === 0) {
        throw new DomainError(
          `User version conflict: expected version ${loadedVersion}`,
          'VERSION_CONFLICT',
        );
      }

      this.loadedVersions.set(user.id, nextVersion);
    }
  }
}
