import { createApp } from './http/app';
import { InitiateRentalService } from './application/services/InitiateRentalService';
import { MarketplacePaymentService } from './application/services/MarketplacePaymentService';
import { AdminControlService } from './application/services/AdminControlService';
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
import { InMemoryFreezeRepository } from './infrastructure/repositories/InMemoryFreezeRepository';
import { InMemoryAuditLogRepository } from './infrastructure/repositories/InMemoryAuditLogRepository';
import { InMemoryManualReviewRepository } from './infrastructure/repositories/InMemoryManualReviewRepository';
import { PostgresUserRepository } from './infrastructure/repositories/PostgresUserRepository';
import { PostgresWatchRepository } from './infrastructure/repositories/PostgresWatchRepository';
import { PostgresRentalRepository } from './infrastructure/repositories/PostgresRentalRepository';
import { PostgresClaimRepository } from './infrastructure/repositories/PostgresClaimRepository';
import { PostgresManualReviewRepository } from './infrastructure/repositories/PostgresManualReviewRepository';
import { PostgresFreezeRepository } from './infrastructure/repositories/PostgresFreezeRepository';
import { PostgresAuditLogRepository } from './infrastructure/repositories/PostgresAuditLogRepository';
import { ExposureConfig } from './domain/services/PlatformExposureEngine';
import { ExposureSnapshotService } from './application/services/ExposureSnapshotService';
import { AuditLog } from './application/audit/AuditLog';
import { InMemoryAuditSink } from './infrastructure/audit/InMemoryAuditSink';
import {
  WebhookController,
  InMemoryProcessedWebhookEventStore,
  ProcessedWebhookEventStore,
  WebhookVerifier,
} from './http/webhookController';
import { IdempotencyStore } from './http/idempotency/IdempotencyStore';
import { InMemoryIdempotencyStore } from './http/idempotency/IdempotencyStore';
import { InMemoryConnectedAccountStore } from './http/routes/ownerRoutes';
import { PaymentProvider } from './domain/interfaces/PaymentProvider';
import { UserRepository } from './domain/interfaces/UserRepository';
import { WatchRepository } from './domain/interfaces/WatchRepository';
import { RentalRepository } from './domain/interfaces/RentalRepository';
import { ClaimRepository } from './domain/interfaces/ClaimRepository';
import { ReviewRepository } from './domain/interfaces/ReviewRepository';
import { FreezeRepository } from './domain/interfaces/FreezeRepository';
import { AuditLogRepository } from './domain/interfaces/AuditLogRepository';
import { ManualReviewRepository } from './domain/interfaces/ManualReviewRepository';
import { PostgresIdempotencyStore } from './infrastructure/persistence/PostgresIdempotencyStore';
import { PostgresWebhookEventStore } from './infrastructure/persistence/PostgresWebhookEventStore';
import { runMigration } from './infrastructure/db/migrate';
import { closePool } from './infrastructure/db/connection';
import { JwtTokenService } from './auth/JwtTokenService';
import { loadAuthConfig } from './auth/AuthConfig';
import { OutboxRepository } from './domain/interfaces/OutboxRepository';
import { InMemoryOutboxRepository } from './infrastructure/repositories/InMemoryOutboxRepository';
import { PostgresOutboxRepository } from './infrastructure/repositories/PostgresOutboxRepository';
import { OutboxDiagnosticsService } from './application/services/OutboxDiagnosticsService';
import { OutboxWorker } from './infrastructure/outbox/OutboxWorker';
import { OutboxDispatcher } from './infrastructure/outbox/OutboxDispatcher';
import {
  CreateCheckoutSessionHandler,
  CapturePaymentHandler,
  RefundPaymentHandler,
  TransferToOwnerHandler,
  CreateConnectedAccountHandler,
  CreateOnboardingLinkHandler,
} from './infrastructure/outbox/ProviderCommandHandlers';
import { ReconciliationRepository } from './domain/interfaces/ReconciliationRepository';
import { InMemoryReconciliationRepository } from './infrastructure/repositories/InMemoryReconciliationRepository';
import { PostgresReconciliationRepository } from './infrastructure/repositories/PostgresReconciliationRepository';
import { ReconciliationEngine } from './application/services/ReconciliationEngine';
import { RepairExecutor } from './application/services/RepairExecutor';
import { StubProviderSnapshotAdapter } from './infrastructure/reconciliation/StubProviderSnapshotAdapter';
import { StripeProviderSnapshotAdapter } from './infrastructure/reconciliation/StripeProviderSnapshotAdapter';
import { ReconciliationWorker } from './infrastructure/reconciliation/ReconciliationWorker';
import { loadResilienceConfig } from './infrastructure/resilience/ResilienceConfig';
import { CircuitBreaker } from './infrastructure/resilience/CircuitBreaker';
import { HealthMonitor } from './infrastructure/resilience/HealthMonitor';
import { RateLimiter, InMemoryRateLimiterAdapter } from './infrastructure/resilience/RateLimiter';
import { StructuredLogger, ConsoleLogSink } from './infrastructure/resilience/StructuredLogger';
import { generateWorkerId } from './infrastructure/coordination/WorkerIdentity';
import { WorkerRegistry } from './infrastructure/coordination/WorkerRegistry';
import { DistributedLeaseManager } from './infrastructure/coordination/DistributedLeaseManager';
import { PostgresRateLimiterAdapter } from './infrastructure/coordination/PostgresRateLimiterAdapter';
import { MetricsRegistry } from './observability/metrics/MetricsRegistry';
import { SystemMetricsCollector } from './observability/collectors/SystemMetricsCollector';
import { WorkerMetricsCollector } from './observability/collectors/WorkerMetricsCollector';
import { ReconciliationMetricsCollector } from './observability/collectors/ReconciliationMetricsCollector';
import { SystemDiagnosticsService } from './observability/diagnostics/SystemDiagnosticsService';
import { IncidentSnapshotBuilder } from './observability/diagnostics/IncidentSnapshotBuilder';
import { SLOEvaluator } from './observability/slos/SLOEvaluator';

/**
 * Composition root.
 *
 * All dependencies are wired here — no service locator, no DI container.
 * Explicit constructor injection only.
 */

const usePostgres = Boolean(process.env.DATABASE_URL);
const useStripe = Boolean(process.env.STRIPE_SECRET_KEY);

// --- Auth ---
const authConfig = loadAuthConfig();
const tokenService = new JwtTokenService(authConfig);

// --- Resilience Config ---
const resilienceConfig = loadResilienceConfig();

// --- Worker Identity ---
const workerId = generateWorkerId();

// --- Coordination Infrastructure ---
const workerRegistry = usePostgres ? new WorkerRegistry(30_000) : null;
const leaseManager = usePostgres ? new DistributedLeaseManager() : null;

// --- Structured Logger ---
const logger = new StructuredLogger(new ConsoleLogSink());

// --- Circuit Breakers ---
const providerWriteBreaker = new CircuitBreaker({
  name: 'provider-write',
  failureThreshold: resilienceConfig.breakerFailureThreshold,
  resetTimeoutMs: resilienceConfig.breakerResetTimeoutMs,
  halfOpenMaxProbes: resilienceConfig.breakerHalfOpenMaxProbes,
});

const providerReadBreaker = new CircuitBreaker({
  name: 'provider-read',
  failureThreshold: resilienceConfig.breakerFailureThreshold,
  resetTimeoutMs: resilienceConfig.breakerResetTimeoutMs,
  halfOpenMaxProbes: resilienceConfig.breakerHalfOpenMaxProbes,
});

const allBreakers = [providerWriteBreaker, providerReadBreaker];

// --- Infrastructure: Repositories ---
let userRepo: UserRepository;
let watchRepo: WatchRepository;
let rentalRepo: RentalRepository;
let claimRepo: ClaimRepository;
let reviewRepo: ReviewRepository;
let freezeRepo: FreezeRepository;
let auditLogRepo: AuditLogRepository;
let manualReviewRepo: ManualReviewRepository;
let idempotencyStore: IdempotencyStore;
let processedEvents: ProcessedWebhookEventStore;

let outboxRepo: OutboxRepository;
let reconciliationRepo: ReconciliationRepository;

if (usePostgres) {
  userRepo = new PostgresUserRepository();
  watchRepo = new PostgresWatchRepository();
  rentalRepo = new PostgresRentalRepository();
  claimRepo = new PostgresClaimRepository();
  const pgReviewRepo = new PostgresManualReviewRepository();
  reviewRepo = pgReviewRepo;
  manualReviewRepo = pgReviewRepo;
  freezeRepo = new PostgresFreezeRepository();
  auditLogRepo = new PostgresAuditLogRepository();
  idempotencyStore = new PostgresIdempotencyStore();
  processedEvents = new PostgresWebhookEventStore();
  outboxRepo = new PostgresOutboxRepository();
  reconciliationRepo = new PostgresReconciliationRepository();
} else {
  userRepo = new InMemoryUserRepository();
  watchRepo = new InMemoryWatchRepository();
  rentalRepo = new InMemoryRentalRepository();
  claimRepo = new InMemoryClaimRepository();
  reviewRepo = new InMemoryReviewRepository();
  manualReviewRepo = new InMemoryManualReviewRepository();
  freezeRepo = new InMemoryFreezeRepository();
  auditLogRepo = new InMemoryAuditLogRepository();
  idempotencyStore = new InMemoryIdempotencyStore();
  processedEvents = new InMemoryProcessedWebhookEventStore();
  outboxRepo = new InMemoryOutboxRepository();
  reconciliationRepo = new InMemoryReconciliationRepository();
}

const kycRepo = new InMemoryKycRepository();
const insuranceRepo = new InMemoryInsuranceRepository();

// --- Health Monitor ---
const healthMonitor = new HealthMonitor(resilienceConfig, allBreakers, {
  outboxPending: async () => {
    const diag = await outboxRepo.diagnostics();
    return diag.pending + diag.processing;
  },
  reconUnresolvedCritical: async () => {
    const diag = await reconciliationRepo.diagnostics();
    return (diag.countBySeverity['CRITICAL'] ?? 0);
  },
}, workerRegistry);

// --- Infrastructure: Payment Provider ---
let paymentProvider: PaymentProvider;
let webhookVerifier: WebhookVerifier;
let stripeInstance: import('stripe').default | null = null;

if (useStripe) {
  const stripeConfig = loadStripeConfig();
  const stripeProvider = new StripePaymentProvider(stripeConfig);
  paymentProvider = stripeProvider;
  stripeInstance = stripeProvider.getStripeInstance();

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
const connectedAccountStore = new InMemoryConnectedAccountStore();

// --- Outbox Infrastructure ---
const outboxDiagnosticsService = new OutboxDiagnosticsService(outboxRepo);

const outboxDispatcher = new OutboxDispatcher();
outboxDispatcher.register('payment.checkout_session.create', new CreateCheckoutSessionHandler(paymentProvider));
outboxDispatcher.register('payment.capture', new CapturePaymentHandler(paymentProvider));
outboxDispatcher.register('payment.refund', new RefundPaymentHandler(paymentProvider));
outboxDispatcher.register('payment.transfer_to_owner', new TransferToOwnerHandler(paymentProvider));
outboxDispatcher.register('payment.connected_account.create', new CreateConnectedAccountHandler(paymentProvider));
outboxDispatcher.register('payment.onboarding_link.create', new CreateOnboardingLinkHandler(paymentProvider));

const outboxLogger = logger.child({ workerName: 'outbox-worker' });
const outboxWorker = new OutboxWorker(outboxRepo, outboxDispatcher, {
  workerId,
  batchSize: resilienceConfig.outboxWorkerBatchSize,
  pollIntervalMs: 1000,
  staleLeaseThresholdMs: 60_000,
}, {
  info: (msg, meta) => outboxLogger.info(msg, meta),
  warn: (msg, meta) => outboxLogger.warn(msg, meta),
  error: (msg, meta) => outboxLogger.error(msg, meta),
});

// --- Reconciliation Infrastructure ---
const providerSnapshotAdapter = stripeInstance
  ? new StripeProviderSnapshotAdapter(stripeInstance)
  : new StubProviderSnapshotAdapter();
const repairExecutor = new RepairExecutor(reconciliationRepo, rentalRepo, freezeRepo, manualReviewRepo, auditLogRepo);
const reconciliationEngine = new ReconciliationEngine(reconciliationRepo, rentalRepo, providerSnapshotAdapter, repairExecutor, auditLogRepo);
const reconLogger = logger.child({ workerName: 'reconciliation-worker' });
const reconciliationWorker = new ReconciliationWorker(
  reconciliationEngine,
  { intervalMs: 300_000, triggeredBy: 'reconciliation-worker' },
  leaseManager ?? undefined,
  workerId,
  {
    info: (msg, meta) => reconLogger.info(msg, meta),
    warn: (msg, meta) => reconLogger.warn(msg, meta),
    error: (msg, meta) => reconLogger.error(msg, meta),
  },
);

// --- Rate Limiters ---
function createRateLimitAdapter() {
  if (usePostgres) {
    return new PostgresRateLimiterAdapter(resilienceConfig.rateLimitWindowMs);
  }
  return new InMemoryRateLimiterAdapter();
}

const rentalRateLimiter = new RateLimiter(
  createRateLimitAdapter(),
  resilienceConfig.rateLimitWindowMs,
  resilienceConfig.rateLimitRentalInitiation,
);
const ownerRateLimiter = new RateLimiter(
  createRateLimitAdapter(),
  resilienceConfig.rateLimitWindowMs,
  resilienceConfig.rateLimitOwnerOnboarding,
);
const adminRepairRateLimiter = new RateLimiter(
  createRateLimitAdapter(),
  resilienceConfig.rateLimitWindowMs,
  resilienceConfig.rateLimitAdminRepair,
);

// --- Observability ---
const metricsRegistry = MetricsRegistry.getInstance();
const systemMetricsCollector = new SystemMetricsCollector(metricsRegistry, allBreakers);
const workerMetricsCollector = new WorkerMetricsCollector(metricsRegistry);
const reconciliationMetricsCollector = new ReconciliationMetricsCollector(metricsRegistry);

const diagnosticsDataSources = {
  getOutboxDiagnostics: () => outboxRepo.diagnostics(),
  getReconciliationDiagnostics: () => reconciliationRepo.diagnostics(),
};

const diagnosticsService = new SystemDiagnosticsService(
  allBreakers, healthMonitor, diagnosticsDataSources, metricsRegistry,
);

const sloEvaluator = new SLOEvaluator(metricsRegistry, diagnosticsDataSources);

// Expose collectors for future instrumentation hooks
void systemMetricsCollector;
void workerMetricsCollector;
void reconciliationMetricsCollector;

// --- Application Services ---
const initiateRentalService = new InitiateRentalService(paymentProvider, auditLog, outboxRepo);
const marketplacePaymentService = new MarketplacePaymentService(paymentProvider, auditLog, outboxRepo);
const adminControlService = new AdminControlService(freezeRepo, auditLogRepo, manualReviewRepo);

// --- Incident Snapshot ---
const incidentSnapshotBuilder = new IncidentSnapshotBuilder(outboxRepo, reconciliationRepo, auditLog);

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
    healthMonitor,
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
  admin: {
    adminControlService,
  },
  outboxAdmin: {
    outboxDiagnosticsService,
  },
  reconciliationAdmin: {
    reconciliationEngine,
    repairExecutor,
    reconciliationRepo,
  },
  resilienceAdmin: {
    healthMonitor,
    breakers: allBreakers,
    resilienceConfig,
    workerRegistry: workerRegistry ?? undefined,
    leaseManager: leaseManager ?? undefined,
  },
  observability: {
    registry: metricsRegistry,
    diagnosticsService,
    incidentSnapshotBuilder,
    sloEvaluator,
  },
  webhookController,
  tokenService,
  rateLimiters: {
    rentalInitiation: rentalRateLimiter,
    ownerOnboarding: ownerRateLimiter,
    adminRepair: adminRepairRateLimiter,
  },
});

// --- Start ---
const PORT = process.env.PORT ?? 3000;

async function start(): Promise<void> {
  if (usePostgres) {
    logger.info('Running schema migration', { operation: 'startup' });
    await runMigration();
    logger.info('Schema migration complete', { operation: 'startup' });

    // Register workers in the cluster
    if (workerRegistry) {
      await workerRegistry.register(workerId, 'api', { pid: process.pid });
      workerRegistry.startHeartbeat(workerId);
      await workerRegistry.cleanupStopped();
      logger.info('Worker registered', { operation: 'startup', workerId });
    }
  }

  // Start workers
  outboxWorker.start();
  reconciliationWorker.start();

  // Record initial worker heartbeats
  healthMonitor.recordWorkerHeartbeat('outbox-worker', true);
  healthMonitor.recordWorkerHeartbeat('reconciliation-worker', true);

  app.listen(PORT, () => {
    logger.info('Server started', {
      operation: 'startup',
      port: PORT,
      persistence: usePostgres ? 'postgres' : 'memory',
      stripe: useStripe ? 'live' : 'stub',
    });
  });
}

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`, { operation: 'shutdown', workerId });

  // 1. Stop polling loops
  outboxWorker.stop();
  reconciliationWorker.stop();

  if (usePostgres) {
    // 2. Release outbox event leases back to PENDING
    try {
      const released = await outboxWorker.releaseAllLeases();
      if (released > 0) {
        logger.info('Released outbox event leases', { operation: 'shutdown', released, workerId });
      }
    } catch (err) {
      logger.warn('Failed to release outbox leases', { operation: 'shutdown', error: err instanceof Error ? err.message : String(err) });
    }

    // 3. Release singleton leases (reconciliation)
    try {
      await reconciliationWorker.releaseLease();
    } catch (err) {
      logger.warn('Failed to release reconciliation lease', { operation: 'shutdown', error: err instanceof Error ? err.message : String(err) });
    }

    // 4. Stop heartbeat and mark worker as STOPPED
    if (workerRegistry) {
      workerRegistry.stopHeartbeat();
      try {
        await workerRegistry.deregister(workerId);
        logger.info('Worker deregistered', { operation: 'shutdown', workerId });
      } catch (err) {
        logger.warn('Failed to deregister worker', { operation: 'shutdown', error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 5. Close DB pool
    await closePool();
  }

  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

start().catch((err) => {
  logger.error('Failed to start server', { operation: 'startup', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

export { app };
