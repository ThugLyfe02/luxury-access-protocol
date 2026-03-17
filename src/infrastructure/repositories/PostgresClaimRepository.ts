import { PoolClient } from 'pg';
import { InsuranceClaim } from '../../domain/entities/InsuranceClaim';
import { ClaimRepository } from '../../domain/interfaces/ClaimRepository';
import { DomainError } from '../../domain/errors/DomainError';
import { PostgresClient } from '../db/PostgresClient';

const OPEN_STATUSES = ['FILED', 'UNDER_REVIEW', 'APPROVED'];

const SELECT_COLS = `
  id, policy_id, rental_id, watch_id, claim_amount, reason,
  filed_at, status, reviewed_by, reviewed_at, paid_out_at,
  payout_amount, denial_reason, version
`;

export class PostgresClaimRepository implements ClaimRepository {
  private readonly db: PostgresClient;

  constructor(client?: PoolClient) {
    this.db = client ? PostgresClient.fromTransaction(client) : new PostgresClient();
  }

  private hydrateRow(row: Record<string, unknown>): InsuranceClaim {
    return InsuranceClaim.restore({
      id: row.id as string,
      policyId: row.policy_id as string,
      rentalId: row.rental_id as string,
      watchId: row.watch_id as string,
      claimAmount: parseFloat(row.claim_amount as string),
      reason: row.reason as string,
      filedAt: new Date(row.filed_at as string),
      status: (row.status as string).toUpperCase(),
      reviewedBy: (row.reviewed_by as string) ?? null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
      paidOutAt: row.paid_out_at ? new Date(row.paid_out_at as string) : null,
      payoutAmount: row.payout_amount !== null ? parseFloat(row.payout_amount as string) : null,
      denialReason: (row.denial_reason as string) ?? null,
      version: row.version as number,
    });
  }

  async findById(id: string): Promise<InsuranceClaim | null> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM claims WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.hydrateRow(rows[0]);
  }

  async findByRentalId(rentalId: string): Promise<InsuranceClaim[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM claims WHERE rental_id = $1`,
      [rentalId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findByWatchId(watchId: string): Promise<InsuranceClaim[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM claims WHERE watch_id = $1`,
      [watchId],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findOpenByWatchId(watchId: string): Promise<InsuranceClaim[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM claims WHERE watch_id = $1 AND status = ANY($2)`,
      [watchId, OPEN_STATUSES],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async findOpenByRentalId(rentalId: string): Promise<InsuranceClaim[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLS} FROM claims WHERE rental_id = $1 AND status = ANY($2)`,
      [rentalId, OPEN_STATUSES],
    );
    return rows.map((r: Record<string, unknown>) => this.hydrateRow(r));
  }

  async save(claim: InsuranceClaim): Promise<void> {
    const { rows: existing } = await this.db.query(
      `SELECT version FROM claims WHERE id = $1`,
      [claim.id],
    );

    if (existing.length === 0) {
      await this.db.query(
        `INSERT INTO claims (
          id, policy_id, rental_id, watch_id, claim_amount, reason,
          filed_at, status, reviewed_by, reviewed_at, paid_out_at,
          payout_amount, denial_reason, created_at, updated_at, version
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now(),$14)`,
        [
          claim.id, claim.policyId, claim.rentalId, claim.watchId,
          claim.claimAmount, claim.reason, claim.filedAt, claim.status,
          claim.reviewedBy, claim.reviewedAt, claim.paidOutAt,
          claim.payoutAmount, claim.denialReason, claim.version,
        ],
      );
    } else {
      const storedVersion = existing[0].version as number;
      const expectedStored = claim.version - 1;

      if (storedVersion !== expectedStored) {
        throw new DomainError(
          `Claim version conflict: expected stored version ${expectedStored}, found ${storedVersion}`,
          'VERSION_CONFLICT',
        );
      }

      const { rowCount } = await this.db.query(
        `UPDATE claims SET
          status = $1, reviewed_by = $2, reviewed_at = $3,
          paid_out_at = $4, payout_amount = $5, denial_reason = $6,
          updated_at = now(), version = $7
        WHERE id = $8 AND version = $9`,
        [
          claim.status, claim.reviewedBy, claim.reviewedAt,
          claim.paidOutAt, claim.payoutAmount, claim.denialReason,
          claim.version, claim.id, storedVersion,
        ],
      );

      if (rowCount === 0) {
        throw new DomainError(
          'Claim version conflict: concurrent modification detected',
          'VERSION_CONFLICT',
        );
      }
    }
  }
}
