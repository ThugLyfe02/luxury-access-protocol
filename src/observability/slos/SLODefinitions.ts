/**
 * SLO definitions for the luxury access platform.
 *
 * Each SLO has:
 * - name, description
 * - target (percentage or absolute)
 * - window (rolling period for evaluation)
 * - thresholds for healthy / degraded / critical
 */

export type SLOHealth = 'healthy' | 'degraded' | 'critical';

export interface SLODefinition {
  readonly name: string;
  readonly description: string;
  readonly targetPercent?: number;
  readonly targetMaxMs?: number;
  readonly targetMaxPercent?: number;
  readonly windowMs: number;
}

export interface SLOResult {
  readonly name: string;
  readonly status: SLOHealth;
  readonly currentValue: number;
  readonly target: number;
  readonly unit: string;
  readonly windowMs: number;
}

export const SLO_RENTAL_SUCCESS: SLODefinition = {
  name: 'rental_success_rate',
  description: 'Rental initiation success rate',
  targetPercent: 99,
  windowMs: 3_600_000, // 1 hour
};

export const SLO_WEBHOOK_SUCCESS: SLODefinition = {
  name: 'webhook_processing_success',
  description: 'Webhook processing success rate',
  targetPercent: 99.5,
  windowMs: 3_600_000,
};

export const SLO_RECONCILIATION_LAG: SLODefinition = {
  name: 'reconciliation_completion_lag',
  description: 'Reconciliation completion lag (max ms since last successful run)',
  targetMaxMs: 300_000, // 5 minutes
  windowMs: 3_600_000,
};

export const SLO_DEAD_LETTER_RATE: SLODefinition = {
  name: 'dead_letter_rate',
  description: 'Dead-letter rate as percentage of total outbox events',
  targetMaxPercent: 0.1,
  windowMs: 3_600_000,
};

export const ALL_SLOS: readonly SLODefinition[] = [
  SLO_RENTAL_SUCCESS,
  SLO_WEBHOOK_SUCCESS,
  SLO_RECONCILIATION_LAG,
  SLO_DEAD_LETTER_RATE,
];
