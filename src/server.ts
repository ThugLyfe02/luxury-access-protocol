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
import { ExposureConfig } from './domain/services/PlatformExposureEngine';
import { ManualReviewEngine } from './application/services/ManualReviewEngine';
import { AuditLog } from './application/audit/AuditLog';
import { InMemoryAuditSink } from './infrastructure/audit/InMemoryAuditSink';
import { RentalController } from './http/rentalController';
import { WebhookController } from './http/webhookController';

/**
 * Composition root.
 *
 * All dependencies are wired here — no service locator, no DI container.
 * Explicit constructor injection only.
 *
 * This is a reconstruction scaffold, not a production server.
 * Known gaps:
 * - StripePaymentProvider is a stub (throws "Not implemented")
 * - No real auth middleware (actor derived from request body)
 * - No Stripe signature verification on webhooks
 * - No persistent storage (in-memory repos)
 * - Structured audit log (in-memory sink)
 * - No CORS / rate limiting / helmet
 */

// --- Infrastructure ---
const paymentProvider = new StripePaymentProvider();
const userRepo = new InMemoryUserRepository();
const watchRepo = new InMemoryWatchRepository();
const rentalRepo = new InMemoryRentalRepository();
const kycRepo = new InMemoryKycRepository();
const insuranceRepo = new InMemoryInsuranceRepository();
const reviewRepo = new InMemoryReviewRepository();
const claimRepo = new InMemoryClaimRepository();

// --- Configuration ---
// Default exposure config for development. In production these
// values come from a configuration service or environment.
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

// Parse JSON bodies for all routes except the webhook endpoint.
// Stripe webhooks need the raw body for signature verification
// (not yet implemented, but we preserve the correct structural pattern).
app.use('/webhooks', express.json());
app.use(express.json());

// --- Routes ---

// POST /rentals — Initiate a new rental
app.post('/rentals', (req, res) => rentalController.initiateRental(req, res));

// POST /webhooks/stripe — Stripe event callback
app.post('/webhooks/stripe', (req, res) => webhookController.handleStripeEvent(req, res));

// --- Health check ---
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// --- Start ---
const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`luxury-access-protocol listening on port ${PORT}`);
});

export { app };
