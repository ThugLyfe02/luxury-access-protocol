import { PoolClient } from 'pg';
import { Rental } from '../../domain/entities/Rental';
import { RentalRepository } from '../../domain/interfaces/RentalRepository';
import { DomainError } from '../../domain/errors/DomainError';
import { getPool } from '../db/connection';

const TERMINAL_STATUSES = ['FUNDS_RELEASED_TO_OWNER', 'REFUNDED'] as const;

/**
 * PostgreSQL-backed RentalRepository.
 *
 * Concurrency strategy:
 * - Rental domain entity carries its own version field.
 * - On UPDATE, the WHERE clause matches (id, version - 1) — the version
 *   the entity held at load time. If 0 rows affected → VERSION_CONFLICT.
 *
 * Double-rental prevention (defense in depth):
 * 1. Application-level: `save()` pre-checks for an active rental on the
 *    same watch before INSERT.
 * 2. Database-level: A partial unique index on (watch_id) WHERE
 *    escrow_status NOT IN terminal states guarantees at most one
 *    active rental per watch, even under concurrent inserts.
 * 3. On unique violation → DomainError('WATCH_ALREADY_RESERVED').
 */
export class PostgresRentalRepository implements RentalRepository {
  private readonly txClient: PoolClient | null;

  constructor(client?: PoolClient) {
    this.txClient = client ?? null;
  }

  private query(text: string, values: unknown[]) {
    const executor = this.txClient ?? getPool();
    return executor.query(text, values);
  }

  private hydrateRow(row: Record<string, unknown>): Rental {
    return Rental.restore({
      id: row.id as string,
      renterId: row.renter_id as string,
      watchId: row.watch_id as string,
      rentalPrice: parseFloat(row.rental_price as string),
      escrowStatus: (row.escrow_status as string).toUpperCase(),
      externalPaymentIntentId: (row.external_payment_intent_id as string) ?? null,
      externalTransferId: (row.external_transfer_id as string) ?? null,
      returnConfirmed: row.return_confirmed as boolean,
      disputeOpen: row.dispute_open as boolean,
      createdAt: new Date(row.created_at as string),
      version: row.version as number,
    });
  }

  async findById(id: string): Promise<Rental | null> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) return null;
    return this.hydrateRow(rows[0]);
  }

  async findByExternalPaymentIntentId(intentId: string): Promise<Rental | null> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals WHERE external_payment_intent_id = $1`,
      [intentId],
    );

    if (rows.length === 0) return null;
    return this.hydrateRow(rows[0]);
  }

  async findByRenterId(renterId: string): Promise<Rental[]> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals WHERE renter_id = $1`,
      [renterId],
    );

    return rows.map((row: Record<string, unknown>) => this.hydrateRow(row));
  }

  async findByWatchId(watchId: string): Promise<Rental[]> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals WHERE watch_id = $1`,
      [watchId],
    );

    return rows.map((row: Record<string, unknown>) => this.hydrateRow(row));
  }

  async findActiveByWatchId(watchId: string): Promise<Rental[]> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals
       WHERE watch_id = $1 AND escrow_status NOT IN ($2, $3)`,
      [watchId, TERMINAL_STATUSES[0], TERMINAL_STATUSES[1]],
    );

    return rows.map((row: Record<string, unknown>) => this.hydrateRow(row));
  }

  async findAll(): Promise<Rental[]> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals`,
      [],
    );

    return rows.map((row: Record<string, unknown>) => this.hydrateRow(row));
  }

  async findAllActive(): Promise<Rental[]> {
    const { rows } = await this.query(
      `SELECT id, renter_id, watch_id, rental_price, escrow_status,
              external_payment_intent_id, external_transfer_id,
              return_confirmed, dispute_open,
              created_at, version
       FROM rentals
       WHERE escrow_status NOT IN ($1, $2)`,
      [TERMINAL_STATUSES[0], TERMINAL_STATUSES[1]],
    );

    return rows.map((row: Record<string, unknown>) => this.hydrateRow(row));
  }

  async save(rental: Rental): Promise<void> {
    // Determine if this is an INSERT (new) or UPDATE (existing).
    // A new rental always has version 0 and escrow status NOT_STARTED
    // (set by Rental.create). After startExternalPayment() the version
    // becomes 1. We check whether the row already exists in the DB.
    const { rows: existing } = await this.query(
      `SELECT version FROM rentals WHERE id = $1`,
      [rental.id],
    );

    if (existing.length === 0) {
      // -------------------------------------------------------
      // INSERT — new rental
      // -------------------------------------------------------

      // Application-level double-rental pre-check
      const { rows: activeRows } = await this.query(
        `SELECT id FROM rentals
         WHERE watch_id = $1 AND escrow_status NOT IN ($2, $3)
         LIMIT 1`,
        [rental.watchId, TERMINAL_STATUSES[0], TERMINAL_STATUSES[1]],
      );

      if (activeRows.length > 0) {
        throw new DomainError(
          'Watch already has an active rental',
          'WATCH_ALREADY_RESERVED',
        );
      }

      try {
        await this.query(
          `INSERT INTO rentals (
            id, renter_id, watch_id, rental_price, escrow_status,
            external_payment_intent_id, external_transfer_id,
            return_confirmed, dispute_open,
            created_at, updated_at, version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)`,
          [
            rental.id,
            rental.renterId,
            rental.watchId,
            rental.rentalPrice,
            rental.escrowStatus,
            rental.externalPaymentIntentId,
            rental.externalTransferId,
            rental.returnConfirmed,
            rental.disputeOpen,
            rental.createdAt,
            rental.version,
          ],
        );
      } catch (error: unknown) {
        // Database-level unique constraint violation (defense in depth)
        if (
          error instanceof Error &&
          'code' in error &&
          (error as { code: string }).code === '23505' &&
          (error as { constraint?: string }).constraint === 'idx_rentals_one_active_per_watch'
        ) {
          throw new DomainError(
            'Watch already has an active rental',
            'WATCH_ALREADY_RESERVED',
          );
        }
        throw error;
      }
    } else {
      // -------------------------------------------------------
      // UPDATE — existing rental with optimistic concurrency
      // -------------------------------------------------------
      const storedVersion = existing[0].version as number;
      // The entity's version must be exactly storedVersion + 1.
      // The domain increments version on every mutation via bumpVersion(),
      // so entity.version == storedVersion + N where N is the number of
      // mutations since load. For single-step saves, N == 1.
      const expectedStoredVersion = rental.version - 1;

      if (storedVersion !== expectedStoredVersion) {
        throw new DomainError(
          `Rental version conflict: expected stored version ${expectedStoredVersion}, found ${storedVersion}`,
          'VERSION_CONFLICT',
        );
      }

      const { rowCount } = await this.query(
        `UPDATE rentals
         SET escrow_status = $1,
             external_payment_intent_id = $2,
             external_transfer_id = $3,
             return_confirmed = $4,
             dispute_open = $5,
             updated_at = now(),
             version = $6
         WHERE id = $7 AND version = $8`,
        [
          rental.escrowStatus,
          rental.externalPaymentIntentId,
          rental.externalTransferId,
          rental.returnConfirmed,
          rental.disputeOpen,
          rental.version,
          rental.id,
          storedVersion,
        ],
      );

      if (rowCount === 0) {
        throw new DomainError(
          `Rental version conflict: concurrent modification detected`,
          'VERSION_CONFLICT',
        );
      }
    }
  }
}
