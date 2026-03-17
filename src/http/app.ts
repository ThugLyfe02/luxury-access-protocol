import express, { Express } from 'express';
import { requestIdMiddleware } from './middleware/requestId';
import { requestLoggerMiddleware } from './middleware/requestLogger';
import { centralErrorHandler } from './middleware/errorHandler';
import { createHealthRoutes, HealthDeps } from './routes/healthRoutes';
import { createRentalRoutes, RentalRouteDeps } from './routes/rentalRoutes';
import { createOwnerRoutes, OwnerRouteDeps } from './routes/ownerRoutes';
import { createAdminRoutes, AdminRouteDeps } from './routes/adminRoutes';
import { createOutboxAdminRoutes, OutboxAdminRouteDeps } from './routes/outboxAdminRoutes';
import { createReconciliationAdminRoutes, ReconciliationAdminRouteDeps } from './routes/reconciliationAdminRoutes';
import { createResilienceAdminRoutes, ResilienceAdminRouteDeps } from './routes/resilienceAdminRoutes';
import { createWebhookRoutes } from './routes/webhookRoutes';
import { WebhookController } from './webhookController';
import { JwtTokenService } from '../auth/JwtTokenService';
import { requireAuth } from '../auth/middleware/requireAuth';
import { requireAdmin as requireAdminMiddleware } from './middleware/requireAdmin';
import { createRateLimitMiddleware } from './middleware/rateLimitMiddleware';
import { RateLimiter } from '../infrastructure/resilience/RateLimiter';

export interface AppDeps {
  health: HealthDeps;
  rental: RentalRouteDeps;
  owner: OwnerRouteDeps;
  admin?: AdminRouteDeps;
  outboxAdmin?: OutboxAdminRouteDeps;
  reconciliationAdmin?: ReconciliationAdminRouteDeps;
  resilienceAdmin?: ResilienceAdminRouteDeps;
  webhookController: WebhookController;
  tokenService: JwtTokenService;
  rateLimiters?: {
    rentalInitiation?: RateLimiter;
    ownerOnboarding?: RateLimiter;
    adminRepair?: RateLimiter;
  };
}

/**
 * Creates and configures the Express application.
 *
 * Route security classification:
 * 1. PUBLIC: GET /health, GET /ready — no auth
 * 2. WEBHOOK-SIGNED: POST /webhooks/stripe — Stripe signature, no bearer auth
 * 3. AUTHENTICATED: rental and owner routes — requireAuth middleware
 * 4. INTERNAL: (none currently exposed) — would use requireInternalAccess
 *
 * Middleware order:
 * 1. Request ID assignment
 * 2. Raw body parsing for webhook route only
 * 3. JSON body parsing for all other routes
 * 4. Request logging
 * 5. Route-specific auth middleware
 * 6. Route-specific rate limiting
 * 7. Route handlers
 * 8. Central error handler (must be last)
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  // 1. Request ID — first, so every log entry has it
  app.use(requestIdMiddleware);

  // 2. Stripe webhook raw body — BEFORE json parser
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  // 3. JSON parsing for all other routes
  app.use(express.json());

  // 4. Request logging
  app.use(requestLoggerMiddleware);

  // 5. PUBLIC routes — no auth required
  app.use(createHealthRoutes(deps.health));

  // 6. WEBHOOK-SIGNED routes — Stripe signature verification, no bearer auth
  app.use(createWebhookRoutes(deps.webhookController));

  // 7. AUTHENTICATED routes — bearer JWT required
  const authMiddleware = requireAuth(deps.tokenService);
  app.use('/rentals', authMiddleware);
  app.use('/owners', authMiddleware);
  app.use('/admin', authMiddleware, requireAdminMiddleware);

  // 8. Rate limiting on specific routes (after auth, before handlers)
  if (deps.rateLimiters?.rentalInitiation) {
    app.post('/rentals', createRateLimitMiddleware(deps.rateLimiters.rentalInitiation));
  }
  if (deps.rateLimiters?.ownerOnboarding) {
    app.post('/owners/connected-account', createRateLimitMiddleware(deps.rateLimiters.ownerOnboarding));
    app.post('/owners/onboarding-link', createRateLimitMiddleware(deps.rateLimiters.ownerOnboarding));
  }

  app.use(createRentalRoutes(deps.rental));
  app.use(createOwnerRoutes(deps.owner));

  // 9. ADMIN routes — requires ADMIN role
  if (deps.admin) {
    app.use(createAdminRoutes(deps.admin));
  }
  if (deps.outboxAdmin) {
    app.use(createOutboxAdminRoutes(deps.outboxAdmin));
  }
  if (deps.reconciliationAdmin) {
    // Rate limit admin repair endpoints
    if (deps.rateLimiters?.adminRepair) {
      app.post('/admin/reconciliation/findings/:findingId/repair',
        createRateLimitMiddleware(deps.rateLimiters.adminRepair));
    }
    app.use(createReconciliationAdminRoutes(deps.reconciliationAdmin));
  }
  if (deps.resilienceAdmin) {
    app.use(createResilienceAdminRoutes(deps.resilienceAdmin));
  }

  // 10. Central error handler — must be registered last
  app.use(centralErrorHandler);

  return app;
}
