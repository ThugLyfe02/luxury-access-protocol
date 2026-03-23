import { PoolClient } from 'pg';
import { SystemFreeze, FreezableEntityType } from '../../domain/entities/SystemFreeze';
import { FreezeRepository } from '../../domain/interfaces/FreezeRepository';
import { DomainError } from '../../domain/errors/DomainError';
import { PostgresClient } from '../db/PostgresClient';

const SELECT_COLS = `id, entity_type, entity_id, reason, frozen_by, active, created_at`;

export class PostgresFreezeRepository implements FreezeRepository {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  private hydrateRow(row: Record<string, unknown>): SystemFreeze {
    return SystemFreeze.restore({
      id: row.id as string,
      entityType: (row.entity_type as string).toUpperCase(),
      entityId: row.entity_id as string,
      reason: row.reason as string,
      frozenBy: row.frozen_by as string,
      createdAt: new Date(row.created_at as string),
      active: row.active as boolean,
    });
  }

  async create(freeze: SystemFreeze): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO freezes (id, entity_type, entity_id, reason, frozen_by, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [freeze.id, freeze.entityType, freeze.entityId, freeze.reason,
         freeze.frozenBy, freeze.active, freeze.createdAt],
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        throw new DomainError(`Freeze ${freeze.id} already exists`, 'DUPLICATE_REQUEST');
      }
      throw error;
    }
  }

  async findActive(entityType: FreezableEntityType, entityId: string): Promise<SystemFreeze[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM freezes WHERE entity_type = $1 AND entity_id = $2 AND active = TRUE`,
      [entityType, entityId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findById(id: string): Promise<SystemFreeze | null> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM freezes WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.hydrateRow(rows[0]);
  }

  async save(freeze: SystemFreeze): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE freezes SET active = $1, updated_at = now() WHERE id = $2`,
      [freeze.active, freeze.id],
    );

    if (rowCount === 0) {
      throw new DomainError(`Freeze ${freeze.id} not found`, 'INVALID_STATE_TRANSITION');
    }
  }
}
