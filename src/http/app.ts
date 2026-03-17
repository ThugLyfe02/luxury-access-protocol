import express, { Express } from 'express';
import { requestIdMiddleware } from './middleware/requestId';
import { requestLoggerMiddleware } from './middleware/requestLogger';
import { centralErrorHandler } from './middleware/errorHandler';
import { createHealthRoutes, HealthDeps } from './routes/healthRoutes';
import { createRentalRoutes, RentalRouteDeps } from './routes/rentalRoutes';
import { createOwnerRoutes, OwnerRouteDeps } from './routes/ownerRoutes';
import { createWebhookRoutes } from './routes/webhookRoutes';
import { WebhookController } from './webhookController';

export interface AppDeps {
  health: HealthDeps;
  rental: RentalRouteDeps;
  owner: OwnerRouteDeps;
  webhookController: WebhookController;
}

/**
 * Creates and configures the Express application.
 *
 * Middleware order:
 * 1. Request ID assignment
 * 2. Raw body parsing for webhook route only
 * 3. JSON body parsing for all other routes
 * 4. Request logging
 * 5. Route handlers
 * 6. Central error handler (must be last)
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  // 1. Request ID — first, so every log entry has it
  app.use(requestIdMiddleware);

  // 2. Stripe webhook raw body — BEFORE json parser
  //    Must be on the exact path to avoid interfering with other routes
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  // 3. JSON parsing for all other routes
  app.use(express.json());

  // 4. Request logging
  app.use(requestLoggerMiddleware);

  // 5. Routes
  app.use(createHealthRoutes(deps.health));
  app.use(createRentalRoutes(deps.rental));
  app.use(createOwnerRoutes(deps.owner));
  app.use(createWebhookRoutes(deps.webhookController));

  // 6. Central error handler — must be registered last
  app.use(centralErrorHandler);

  return app;
}
