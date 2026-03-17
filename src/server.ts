import { createApp } from './http/app';
import { InitiateRentalService } from './application/services/InitiateRentalService';
import { MarketplacePaymentService } from './application/services/MarketplacePaymentService';
import { StripePaymentProvider } from './infrastructure/payments/StripePaymentProvider';
import { StripeWebhookHandler } from './infrastructure/payments/StripeWebhookHandler';
import { loadStripeConfig } from './infrastructure/payments/stripeConfig';
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
import { ExposureSnapshotService } from './application/services/ExposureSnapshotService';
import { AuditLog } from './application/audit/AuditLog';
import { InMemoryAuditSink } from './infrastructure/audit/InMemoryAuditSink';
import {
  WebhookController,
  InMemoryProcessedWebhookEventStore,
  WebhookVerifier,
} from './http/webhookController';
import { InMemoryIdempotencyStore } from './http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from './http/routes/ownerRoutes';
import { PaymentProvider } from './domain/interfaces/PaymentProvider';
import { UserRepository } from './domain/interfaces/UserRepository';
import { WatchRepository } from './domain/interfaces/WatchRepository';
import { RentalRepository } from './domain/interfaces/RentalRepository';
import { runMigration } from './infrastructure/db/migrate';
import { closePool } from './infrastructure/db/connection';
import { JwtTokenService } from './auth/JwtTokenService';
import { loadAuthConfig } from './auth/AuthConfig';

/**
 * Composition root.
 *
 * All dependencies are wired here — no service locator, no DI container.
 * Explicit constructor injection only.
 *
 * Modes:
 *   DATABASE_URL set → Postgres repositories + auto-migration
 *   STRIPE_SECRET_KEY set → real Stripe integration
 *   JWT_SECRET + INTERNAL_API_TOKEN → auth enforcement
 *
 * Auth is always required for user-facing routes.
 * No silent fallback to anonymous access.
 */

const usePostgres = Boolean(process.env.DATABASE_URL);
const useStripe = Boolean(process.env.STRIPE_SECRET_KEY);

// --- Auth ---
const authConfig = loadAuthConfig();
const tokenService = new JwtTokenService(authConfig);

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

const kycRepo = new InMemoryKycRepository();
const insuranceRepo = new InMemoryInsuranceRepository();
const reviewRepo = new InMemoryReviewRepository();
const claimRepo = new InMemoryClaimRepository();

// --- Infrastructure: Payment Provider ---
let paymentProvider: PaymentProvider;
let webhookVerifier: WebhookVerifier;

if (useStripe) {
  const stripeConfig = loadStripeConfig();
  const stripeProvider = new StripePaymentProvider(stripeConfig);
  paymentProvider = stripeProvider;

  const webhookHandler = new StripeWebhookHandler(
    stripeProvider.getStripeInstance(),
    stripeConfig.webhookSecret,
  );
  webhookVerifier = (rawBody, signature) => webhookHandler.processWebhook(rawBody, signature);
} else {
  paymentProvider = {
    createConnectedAccount: async () => { throw new Error('Stripe not configured'); },
    createOnboardingLink: async () => { throw new Error('Stripe not configured'); },
    createCheckoutSession: async () => { throw new Error('Stripe not configured'); },
    capturePayment: async () => { throw new Error('Stripe not configured'); },
    refundPayment: async () => { throw new Error('Stripe not configured'); },
    transferToConnectedAccount: async () => { throw new Error('Stripe not configured'); },
  };
  webhookVerifier = () => { throw new Error('Stripe not configured'); };
}

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

// --- Stores ---
const processedEvents = new InMemoryProcessedWebhookEventStore();
const idempotencyStore = new InMemoryIdempotencyStore();
const connectedAccountStore = new InMemoryConnectedAccountStore();

// --- Application Services ---
const initiateRentalService = new InitiateRentalService(paymentProvider, auditLog);
const marketplacePaymentService = new MarketplacePaymentService(paymentProvider, auditLog);

// --- HTTP Controllers ---
const webhookController = new WebhookController({
  paymentService: marketplacePaymentService,
  rentalRepo,
  auditLog,
  processedEvents,
  verifyWebhook: webhookVerifier,
});

// --- App ---
const app = createApp({
  health: {
    persistence: usePostgres ? 'postgres' : 'memory',
    stripe: useStripe ? 'live' : 'stub',
  },
  rental: {
    initiateRentalService,
    exposureSnapshotService: new ExposureSnapshotService({ rentalRepo, watchRepo, insuranceRepo }),
    userRepo,
    watchRepo,
    rentalRepo,
    kycRepo,
    insuranceRepo,
    claimRepo,
    reviewRepo,
    exposureConfig,
    idempotencyStore,
  },
  owner: {
    paymentProvider,
    userRepo,
    connectedAccountStore,
  },
  webhookController,
  tokenService,
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
    console.log(
      `luxury-access-protocol listening on port ${PORT} ` +
      `(persistence: ${usePostgres ? 'postgres' : 'memory'}, stripe: ${useStripe ? 'live' : 'stub'})`,
    );
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
