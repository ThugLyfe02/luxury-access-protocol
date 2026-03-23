import { Router, Request, Response, NextFunction } from 'express';
import { PaymentProvider } from '../../domain/interfaces/PaymentProvider';
import { UserRepository } from '../../domain/interfaces/UserRepository';
import { MarketplaceRole } from '../../domain/enums/MarketplaceRole';
import {
  validateCreateConnectedAccount,
  validateCreateOnboardingLink,
} from '../dto/validate';
import { successResponse, errorResponse } from '../dto/response';
import { AuthenticatedActor } from '../../auth/types/AuthenticatedActor';

/**
 * Connected account store interface.
 * Tracks owner ↔ connected account mapping to prevent duplicate creation.
 */
export interface ConnectedAccountStore {
  findByOwnerId(ownerId: string): Promise<{ connectedAccountId: string; onboardingComplete: boolean } | null>;
  save(ownerId: string, connectedAccountId: string): Promise<void>;
}

export class InMemoryConnectedAccountStore implements ConnectedAccountStore {
  private readonly store = new Map<string, { connectedAccountId: string; onboardingComplete: boolean }>();

  async findByOwnerId(ownerId: string): Promise<{ connectedAccountId: string; onboardingComplete: boolean } | null> {
    return this.store.get(ownerId) ?? null;
  }

  async save(ownerId: string, connectedAccountId: string): Promise<void> {
    this.store.set(ownerId, { connectedAccountId, onboardingComplete: false });
  }
}

export interface OwnerRouteDeps {
  paymentProvider: PaymentProvider;
  userRepo: UserRepository;
  connectedAccountStore: ConnectedAccountStore;
}

export function createOwnerRoutes(deps: OwnerRouteDeps): Router {
  const router = Router();

  /**
   * POST /owners/:ownerId/connected-account
   *
   * Creates a connected account for a watch owner.
   * Authorization: actor must be the same owner or an admin.
   * Idempotent: returns existing account if one already exists.
   */
  router.post('/owners/:ownerId/connected-account', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = req.actor as AuthenticatedActor;

      const validated = validateCreateConnectedAccount(
        req.params as Record<string, string>,
        req.body,
      );
      if (!validated.valid) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'Request validation failed',
          req.requestId,
          validated.errors,
        ));
        return;
      }

      const { ownerId, email, country } = validated.value;

      // Authorization: must be self or admin
      if (actor.role !== MarketplaceRole.ADMIN && actor.userId !== ownerId) {
        res.status(403).json(errorResponse(
          'FORBIDDEN',
          'You can only manage your own connected account',
          req.requestId,
        ));
        return;
      }

      // Verify owner exists
      const owner = await deps.userRepo.findById(ownerId);
      if (!owner) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Owner not found', req.requestId));
        return;
      }

      // Check for existing connected account (idempotent)
      const existing = await deps.connectedAccountStore.findByOwnerId(ownerId);
      if (existing) {
        res.status(200).json(successResponse({
          connectedAccountId: existing.connectedAccountId,
          alreadyExists: true,
        }, req.requestId));
        return;
      }

      // Create via payment provider
      const result = await deps.paymentProvider.createConnectedAccount({
        ownerId,
        email,
        country,
      });

      // Persist mapping
      await deps.connectedAccountStore.save(ownerId, result.connectedAccountId);

      res.status(201).json(successResponse({
        connectedAccountId: result.connectedAccountId,
        alreadyExists: false,
      }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /owners/:ownerId/onboarding-link
   *
   * Generates a Stripe Connect onboarding link for an owner.
   * Authorization: actor must be the same owner or an admin.
   * Requires the connected account to already exist.
   */
  router.post('/owners/:ownerId/onboarding-link', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = req.actor as AuthenticatedActor;

      const validated = validateCreateOnboardingLink(
        req.params as Record<string, string>,
        req.body,
      );
      if (!validated.valid) {
        res.status(400).json(errorResponse(
          'VALIDATION_ERROR',
          'Request validation failed',
          req.requestId,
          validated.errors,
        ));
        return;
      }

      const { ownerId, connectedAccountId, returnUrl, refreshUrl } = validated.value;

      // Authorization: must be self or admin
      if (actor.role !== MarketplaceRole.ADMIN && actor.userId !== ownerId) {
        res.status(403).json(errorResponse(
          'FORBIDDEN',
          'You can only manage your own connected account',
          req.requestId,
        ));
        return;
      }

      // Verify owner exists
      const owner = await deps.userRepo.findById(ownerId);
      if (!owner) {
        res.status(404).json(errorResponse('NOT_FOUND', 'Owner not found', req.requestId));
        return;
      }

      // Verify connected account exists for this owner
      const existing = await deps.connectedAccountStore.findByOwnerId(ownerId);
      if (!existing || existing.connectedAccountId !== connectedAccountId) {
        res.status(422).json(errorResponse(
          'CONNECTED_ACCOUNT_MISSING',
          'No matching connected account found for this owner',
          req.requestId,
        ));
        return;
      }

      const result = await deps.paymentProvider.createOnboardingLink({
        connectedAccountId,
        returnUrl,
        refreshUrl,
      });

      res.status(200).json(successResponse({ url: result.url }, req.requestId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
