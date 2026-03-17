import { PoolClient } from 'pg';
import { ManualReviewCase, FreezeTarget } from '../../domain/entities/ManualReviewCase';
import { ManualReviewRepository } from '../../domain/interfaces/ManualReviewRepository';
import { ReviewRepository } from '../../domain/interfaces/ReviewRepository';
import { DomainError } from '../../domain/errors/DomainError';
import { PostgresClient } from '../db/PostgresClient';

const SELECT_COLS = `
  id, rental_id, severity, reason, status, assigned_to,
  resolved_by, resolved_at, resolution, freeze_targets,
  sla_deadline, notes, created_at, version
`;

const TERMINAL_STATUSES = ['APPROVED', 'REJECTED'];

/**
 * PostgreSQL-backed ManualReviewRepository.
 * Implements both ManualReviewRepository (Phase G) and ReviewRepository
 * (existing interface) for full compatibility.
 */
export class PostgresManualReviewRepository implements ManualReviewRepository, ReviewRepository {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  private hydrateRow(row: Record<string, unknown>): ManualReviewCase {
    const freezeTargets: FreezeTarget[] = Array.isArray(row.freeze_targets)
      ? row.freeze_targets
      : JSON.parse(row.freeze_targets as string || '[]');

    return ManualReviewCase.restore({
      id: row.id as string,
      rentalId: row.rental_id as string,
      severity: (row.severity as string).toUpperCase(),
      reason: row.reason as string,
      status: (row.status as string).toUpperCase(),
      assignedTo: (row.assigned_to as string) ?? null,
      resolvedBy: (row.resolved_by as string) ?? null,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
      resolution: (row.resolution as string) ?? null,
      freezeTargets,
      slaDeadline: new Date(row.sla_deadline as string),
      createdAt: new Date(row.created_at as string),
      version: row.version as number,
    });
  }

  // --- ManualReviewRepository interface ---

  async create(reviewCase: ManualReviewCase): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO manual_reviews (
          id, rental_id, severity, reason, status, assigned_to,
          resolved_by, resolved_at, resolution, freeze_targets,
          sla_deadline, notes, created_at, updated_at, version
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14)`,
        [
          reviewCase.id, reviewCase.rentalId, reviewCase.severity,
          reviewCase.reason, reviewCase.status, reviewCase.assignedTo,
          reviewCase.resolvedBy, reviewCase.resolvedAt, reviewCase.resolution,
          JSON.stringify(reviewCase.freezeTargets),
          reviewCase.slaDeadline, JSON.stringify(reviewCase.notes),
          reviewCase.createdAt, reviewCase.version,
        ],
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        throw new DomainError(
          `Review case ${reviewCase.id} already exists`,
          'DUPLICATE_REQUEST',
        );
      }
      throw error;
    }
  }

  async findOpenByEntity(entityType: string, entityId: string): Promise<ManualReviewCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM manual_reviews
       WHERE status NOT IN ('APPROVED', 'REJECTED')
         AND (
           (rental_id = $2 AND $1 = 'Rental')
           OR freeze_targets @> $3::jsonb
         )`,
      [entityType, entityId, JSON.stringify([{ entityType, entityId }])],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  // --- ReviewRepository interface ---

  async findById(id: string): Promise<ManualReviewCase | null> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM manual_reviews WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.hydrateRow(rows[0]);
  }

  async findByRentalId(rentalId: string): Promise<ManualReviewCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM manual_reviews WHERE rental_id = $1`,
      [rentalId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findUnresolvedByRentalId(rentalId: string): Promise<ManualReviewCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM manual_reviews
       WHERE rental_id = $1 AND status NOT IN ('APPROVED', 'REJECTED')`,
      [rentalId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findUnresolvedByFreezeTarget(
    entityType: string,
    entityId: string,
  ): Promise<ManualReviewCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM manual_reviews
       WHERE status NOT IN ('APPROVED', 'REJECTED')
         AND freeze_targets @> $1::jsonb`,
      [JSON.stringify([{ entityType, entityId }])],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async save(reviewCase: ManualReviewCase): Promise<void> {
    const { rows: existing } = await this.db.query(
      `SELECT version FROM manual_reviews WHERE id = $1`,
      [reviewCase.id],
    );

    if (existing.length === 0) {
      await this.create(reviewCase);
    } else {
      const storedVersion = existing[0].version as number;
      const expectedStored = reviewCase.version - 1;

      if (storedVersion !== expectedStored) {
        throw new DomainError(
          `Review case version conflict: expected stored version ${expectedStored}, found ${storedVersion}`,
          'VERSION_CONFLICT',
        );
      }

      const { rowCount } = await this.db.query(
        `UPDATE manual_reviews SET
          status = $1, assigned_to = $2, resolved_by = $3,
          resolved_at = $4, resolution = $5, freeze_targets = $6,
          notes = $7, updated_at = now(), version = $8
        WHERE id = $9 AND version = $10`,
        [
          reviewCase.status, reviewCase.assignedTo, reviewCase.resolvedBy,
          reviewCase.resolvedAt, reviewCase.resolution,
          JSON.stringify(reviewCase.freezeTargets),
          JSON.stringify(reviewCase.notes),
          reviewCase.version, reviewCase.id, storedVersion,
        ],
      );

      if (rowCount === 0) {
        throw new DomainError(
          'Review case version conflict: concurrent modification detected',
          'VERSION_CONFLICT',
        );
      }
    }
  }
}
