import express from 'express';
import { InitiateRentalService } from './application/services/InitiateRentalService';
import { MarketplacePaymentService } from './application/services/MarketplacePaymentService';
import { StripePaymentProvider } from './infrastructure/payments/StripePaymentProvider';
import { InMemoryUserRepository } from './infrastructure/repositories/InMemoryUserRepository';
import { InMemoryWatchRepository } from './infrastructure/repositories/InMemoryWatchRepository';
import { InMemoryRentalRepository } from './infrastructure/repositories/InMemoryRentalRepository';
import { InMemoryKycRepository } from './infrastructure/repositories/InMemoryKycRepository';
import { InMemoryInsuranceRepository } from './infrastructure/repositories/InMemoryInsuranceRepository';
import { InMemoryReviewRepository } from './infrastructure/repositories/InMemoryReviewRepository';
import { InMemoryClaimRepository } from './infrastructure/repositories/InMemoryClaimRepository';
import { PostgresUserRepository } from './infrastructure/repositories/PostgresUserRepository';
import { PostgresWatchRepository } from './infrastructure/repositories/PostgresWatchRepository';
import { PostgresRentalRepository } from './infrastructure/repositories/PostgresRentalRepository';
import { ExposureConfig } from './domain/services/PlatformExposureEngine';
import { ManualReviewEngine } from './application/services/ManualReviewEngine';
import { AdminAuditQueryService } from './application/services/AdminAuditQueryService';
import { AdminRentalInspectionService } from './application/services/AdminRentalInspectionService';
import { AdminClaimService } from './application/services/AdminClaimService';
import { AdminExposureQueryService } from './application/services/AdminExposureQueryService';
import { AuditLog } from './application/audit/AuditLog';
import { InMemoryAuditSink } from './infrastructure/audit/InMemoryAuditSink';
import { RentalController } from './http/rentalController';
import { WebhookController } from './http/webhookController';
import { UserRepository } from './domain/interfaces/UserRepository';
import { WatchRepository } from './domain/interfaces/WatchRepository';
import { RentalRepository } from './domain/interfaces/RentalRepository';
import { runMigration } from './infrastructure/db/migrate';
import { closePool } from './infrastructure/db/connection';

/**
 * Composition root.
 *
 * All dependencies are wired here — no service locator, no DI container.
 * Explicit constructor injection only.
 *
 * When DATABASE_URL is set, Postgres-backed repositories are used with
 * the schema auto-migrated on startup. Otherwise falls back to in-memory
 * repositories for local development and testing.
 *
 * Known gaps:
 * - StripePaymentProvider is a stub (throws "Not implemented")
 * - No real auth middleware (actor derived from request body)
 * - No Stripe signature verification on webhooks
 * - Structured audit log (in-memory sink)
 * - No CORS / rate limiting / helmet
 */

const usePostgres = Boolean(process.env.DATABASE_URL);

// --- Infrastructure: Repositories ---
let userRepo: UserRepository;
let watchRepo: WatchRepository;
let rentalRepo: RentalRepository;

if (usePostgres) {
  userRepo = new PostgresUserRepository();
  watchRepo = new PostgresWatchRepository();
  rentalRepo = new PostgresRentalRepository();
} else {
  userRepo = new InMemoryUserRepository();
  watchRepo = new InMemoryWatchRepository();
  rentalRepo = new InMemoryRentalRepository();
}

// These repositories do not yet have Postgres implementations.
// They remain in-memory regardless of DATABASE_URL.
const kycRepo = new InMemoryKycRepository();
const insuranceRepo = new InMemoryInsuranceRepository();
const reviewRepo = new InMemoryReviewRepository();
const claimRepo = new InMemoryClaimRepository();

const paymentProvider = new StripePaymentProvider();

// --- Configuration ---
const exposureConfig: ExposureConfig = {
  capitalReserve: 500_000,
  maxExposureToCapitalRatio: 3.0,
  maxSingleWatchUncoveredExposure: 50_000,
  maxActiveRentals: 100,
};

// --- Audit ---
const auditSink = new InMemoryAuditSink();
const auditLog = new AuditLog(auditSink);

// --- Application Services ---
const initiateRentalService = new InitiateRentalService(paymentProvider, auditLog);
const marketplacePaymentService = new MarketplacePaymentService(paymentProvider, auditLog);
const manualReviewEngine = new ManualReviewEngine(reviewRepo, auditLog);

// --- Admin / Ops Services ---
const adminAuditQueryService = new AdminAuditQueryService(auditLog);
const adminRentalInspectionService = new AdminRentalInspectionService({
  rentalRepo,
  reviewRepo,
  claimRepo,
});
const adminClaimService = new AdminClaimService({
  claimRepo,
  insuranceRepo,
  auditLog,
});
const adminExposureQueryService = new AdminExposureQueryService({
  rentalRepo,
  watchRepo,
  insuranceRepo,
  exposureConfig,
});

// --- HTTP Controllers ---
const rentalController = new RentalController({
  initiateRentalService,
  userRepo,
  watchRepo,
  rentalRepo,
  kycRepo,
  insuranceRepo,
  claimRepo,
  reviewRepo,
  exposureConfig,
});

const webhookController = new WebhookController({
  paymentService: marketplacePaymentService,
  rentalRepo,
  auditLog,
});

// --- Express App ---
const app = express();

app.use('/webhooks', express.json());
app.use(express.json());

// --- Routes ---
app.post('/rentals', (req, res) => rentalController.initiateRental(req, res));
app.post('/webhooks/stripe', (req, res) => webhookController.handleStripeEvent(req, res));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', persistence: usePostgres ? 'postgres' : 'memory' });
});

// --- Start ---
const PORT = process.env.PORT ?? 3000;

async function start(): Promise<void> {
  if (usePostgres) {
    // eslint-disable-next-line no-console
    console.log('DATABASE_URL detected — running schema migration…');
    await runMigration();
    // eslint-disable-next-line no-console
    console.log('Schema migration complete.');
  }

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`luxury-access-protocol listening on port ${PORT} (persistence: ${usePostgres ? 'postgres' : 'memory'})`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (usePostgres) await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (usePostgres) await closePool();
  process.exit(0);
});

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app };
