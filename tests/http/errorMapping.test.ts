import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { requestIdMiddleware } from '../../src/http/middleware/requestId';
import { centralErrorHandler } from '../../src/http/middleware/errorHandler';
import { DomainError } from '../../src/domain/errors/DomainError';

/**
 * Test the central error handler independently.
 * We create a minimal Express app with a route that throws known errors
 * and verify the error handler maps them correctly.
 */
function makeTestApp(errorFactory: () => void) {
  const app = express();
  app.use(requestIdMiddleware);

  app.get('/test', (_req: Request, _res: Response, _next: NextFunction) => {
    errorFactory();
  });

  app.use(centralErrorHandler);
  return app;
}

describe('Central error mapping', () => {
  it('maps CITY_NOT_ACTIVE to 403', async () => {
    const app = makeTestApp(() => {
      throw new DomainError('City is not active', 'CITY_NOT_ACTIVE');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CITY_NOT_ACTIVE');
    expect(res.body.requestId).toBeDefined();
  });

  it('maps WATCH_ALREADY_RESERVED to 409', async () => {
    const app = makeTestApp(() => {
      throw new DomainError('Already reserved', 'WATCH_ALREADY_RESERVED');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WATCH_ALREADY_RESERVED');
  });

  it('maps KYC_REQUIRED to 422', async () => {
    const app = makeTestApp(() => {
      throw new DomainError('KYC required', 'KYC_REQUIRED');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KYC_REQUIRED');
  });

  it('maps PAYMENT_PROVIDER_UNAVAILABLE to 502', async () => {
    const app = makeTestApp(() => {
      throw new DomainError('Provider down', 'PAYMENT_PROVIDER_UNAVAILABLE');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });

  it('maps WEBHOOK_SIGNATURE_INVALID to 401', async () => {
    const app = makeTestApp(() => {
      throw new DomainError('Bad sig', 'WEBHOOK_SIGNATURE_INVALID');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('maps VERSION_CONFLICT to 409', async () => {
    const app = makeTestApp(() => {
      throw new DomainError('Stale write', 'VERSION_CONFLICT');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(409);
  });

  it('returns 500 for unknown errors with no stack leakage', async () => {
    const app = makeTestApp(() => {
      throw new Error('Something secret happened with DB password xyz123');
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred');
    // No stack trace or internal details
    expect(JSON.stringify(res.body)).not.toContain('xyz123');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('returns 500 for non-Error throws', async () => {
    const app = makeTestApp(() => {
      throw 'a string error'; // eslint-disable-line no-throw-literal
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
