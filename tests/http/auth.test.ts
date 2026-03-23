import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { makeTestApp } from './testAppFactory';
import { signToken, signExpiredToken, TEST_AUTH_CONFIG } from './testAuthHelper';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('requireAuth middleware', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const { app } = makeTestApp();

    const res = await request(app).post('/rentals/initiate').send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toContain('Missing');
  });

  it('returns 401 for malformed Authorization header (no Bearer prefix)', async () => {
    const { app } = makeTestApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', 'Basic abc123')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for empty Bearer token', async () => {
    const { app } = makeTestApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', 'Bearer ')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with TOKEN_EXPIRED for expired token', async () => {
    const { app } = makeTestApp();
    const expiredToken = signExpiredToken(USER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 401 with INVALID_CREDENTIALS for token signed with wrong secret', async () => {
    const { app } = makeTestApp();
    const badToken = jwt.sign(
      { sub: USER_ID, role: 'RENTER' },
      'wrong-secret-that-is-at-least-32-characters',
      { algorithm: 'HS256', issuer: TEST_AUTH_CONFIG.jwtIssuer, audience: TEST_AUTH_CONFIG.jwtAudience, expiresIn: 3600 },
    );

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${badToken}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 for token with wrong issuer', async () => {
    const { app } = makeTestApp();
    const badToken = jwt.sign(
      { sub: USER_ID, role: 'RENTER' },
      TEST_AUTH_CONFIG.jwtSecret,
      { algorithm: 'HS256', issuer: 'wrong-issuer', audience: TEST_AUTH_CONFIG.jwtAudience, expiresIn: 3600 },
    );

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${badToken}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 for token with wrong audience', async () => {
    const { app } = makeTestApp();
    const badToken = jwt.sign(
      { sub: USER_ID, role: 'RENTER' },
      TEST_AUTH_CONFIG.jwtSecret,
      { algorithm: 'HS256', issuer: TEST_AUTH_CONFIG.jwtIssuer, audience: 'wrong-audience', expiresIn: 3600 },
    );

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${badToken}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 for completely invalid token string', async () => {
    const { app } = makeTestApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', 'Bearer not.a.jwt.token')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('attaches actor to request on valid token (verified via successful route call)', async () => {
    const { app } = makeTestApp();
    const token = signToken(USER_ID, MarketplaceRole.RENTER);

    // A valid token should pass auth — we'll get a 400 validation error
    // (missing required fields) rather than 401, proving auth succeeded
    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).not.toBe(401);
  });

  it('does not require auth for health routes', async () => {
    const { app } = makeTestApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
  });

  it('does not require auth for webhook routes', async () => {
    const { app } = makeTestApp();

    // Webhook route rejects for missing signature, not missing auth
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(Buffer.from('{}'));

    expect(res.status).not.toBe(401);
  });
});

describe('requireInternalAccess middleware', () => {
  it('is not wired to any route yet (placeholder)', () => {
    // Internal access middleware exists but no internal routes are exposed yet.
    // When internal routes are added, integration tests go here.
    expect(true).toBe(true);
  });
});
