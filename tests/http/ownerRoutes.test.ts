import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeTestApp } from './testAppFactory';
import { signToken } from './testAuthHelper';
import { User } from '../../src/domain/entities/User';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';

const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';
const ONE_YEAR_AGO = new Date('2025-03-17T12:00:00Z');

async function seedOwner(deps: ReturnType<typeof makeTestApp>['deps']): Promise<void> {
  const owner = User.create({
    id: OWNER_ID,
    role: MarketplaceRole.OWNER,
    trustScore: 90,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.owner.userRepo.save(owner);
}

describe('POST /owners/:ownerId/connected-account', () => {
  it('returns 401 without auth token', async () => {
    const { app } = makeTestApp();

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('creates connected account for valid owner', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.connectedAccountId).toBe('acct_test');
    expect(res.body.data.alreadyExists).toBe(false);
  });

  it('returns existing account idempotently', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);

    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res2 = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res2.status).toBe(200);
    expect(res2.body.data.alreadyExists).toBe(true);
  });

  it('rejects invalid ownerId', async () => {
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);
    const { app } = makeTestApp();

    const res = await request(app)
      .post('/owners/not-a-uuid/connected-account')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid email', async () => {
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);
    const { app } = makeTestApp();

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'not-an-email', country: 'US' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent owner', async () => {
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);
    const { app } = makeTestApp();

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects different non-admin user with 403', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const token = signToken(OTHER_USER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows admin to create connected account for any owner', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const adminToken = signToken(OTHER_USER_ID, MarketplaceRole.ADMIN);

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'owner@test.com', country: 'US' });

    expect(res.status).toBe(201);
    expect(res.body.data.connectedAccountId).toBe('acct_test');
  });
});

describe('POST /owners/:ownerId/onboarding-link', () => {
  it('returns onboarding link for valid account', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);

    // First create the connected account
    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        connectedAccountId: 'acct_test',
        returnUrl: 'https://app.test.com/return',
        refreshUrl: 'https://app.test.com/refresh',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.url).toBe('https://connect.stripe.com/test');
  });

  it('rejects mismatched connected account', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const token = signToken(OWNER_ID, MarketplaceRole.OWNER);

    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/onboarding-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        connectedAccountId: 'acct_wrong',
        returnUrl: 'https://app.test.com/return',
        refreshUrl: 'https://app.test.com/refresh',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONNECTED_ACCOUNT_MISSING');
  });

  it('rejects different non-admin user with 403', async () => {
    const { app, deps } = makeTestApp();
    await seedOwner(deps);
    const ownerToken = signToken(OWNER_ID, MarketplaceRole.OWNER);
    const otherToken = signToken(OTHER_USER_ID, MarketplaceRole.RENTER);

    // Create connected account as owner
    await request(app)
      .post(`/owners/${OWNER_ID}/connected-account`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'owner@test.com', country: 'US' });

    const res = await request(app)
      .post(`/owners/${OWNER_ID}/onboarding-link`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        connectedAccountId: 'acct_test',
        returnUrl: 'https://app.test.com/return',
        refreshUrl: 'https://app.test.com/refresh',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
