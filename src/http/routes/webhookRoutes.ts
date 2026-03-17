import { Router, Request, Response, NextFunction } from 'express';
import { WebhookController } from '../webhookController';
import { errorResponse } from '../dto/response';

/**
 * Stripe webhook route.
 *
 * IMPORTANT: This route MUST receive raw (unparsed) request body
 * for Stripe signature verification. The raw body middleware must be
 * applied before this route in the middleware stack.
 *
 * Accepted Stripe events:
 *   checkout.session.completed          → PAYMENT_AUTHORIZED
 *   payment_intent.amount_capturable_updated → PAYMENT_AUTHORIZED (backup)
 *   payment_intent.succeeded            → PAYMENT_CAPTURED
 *   charge.refunded                     → PAYMENT_REFUNDED
 *   charge.dispute.created              → DISPUTE_OPENED
 *   charge.dispute.closed               → DISPUTE_CLOSED
 */
export function createWebhookRoutes(webhookController: WebhookController): Router {
  const router = Router();

  router.post('/webhooks/stripe', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify raw body is present (must be Buffer from express.raw())
      if (!req.body || !(req.body instanceof Buffer || typeof req.body === 'string')) {
        res.status(400).json(errorResponse(
          'INVALID_REQUEST',
          'Webhook requires raw body',
          req.requestId,
        ));
        return;
      }

      await webhookController.handleStripeEvent(req, res);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
