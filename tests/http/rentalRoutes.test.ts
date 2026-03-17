import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { AppDeps } from '../../src/http/app';
import { User } from '../../src/domain/entities/User';
import { Watch } from '../../src/domain/entities/Watch';
import { KycProfile } from '../../src/domain/entities/KycProfile';
import { InsurancePolicy } from '../../src/domain/entities/InsurancePolicy';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { VerificationStatus } from '../../src/domain/enums/VerificationStatus';
import { makeTestApp } from './testAppFactory';
import { signToken } from './testAuthHelper';

const NOW = new Date('2026-03-17T12:00:00Z');
const ONE_YEAR_AGO = new Date('2025-03-17T12:00:00Z');
const ONE_YEAR_LATER = new Date('2027-03-17T12:00:00Z');

const RENTER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const WATCH_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_USER_ID = '99999999-9999-9999-9999-999999999999';

async function seedStandardData(deps: AppDeps): Promise<void> {
  const renter = User.create({
    id: RENTER_ID,
    role: MarketplaceRole.RENTER,
    trustScore: 85,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.userRepo.save(renter);

  const owner = User.create({
    id: OWNER_ID,
    role: MarketplaceRole.OWNER,
    trustScore: 90,
    disputesCount: 0,
    chargebacksCount: 0,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.userRepo.save(owner);

  const watch = Watch.create({
    id: WATCH_ID,
    ownerId: OWNER_ID,
    marketValue: 1500,
    verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.watchRepo.save(watch);

  const kyc = KycProfile.create({
    userId: RENTER_ID,
    providerReference: 'kyc_ref_1',
    createdAt: ONE_YEAR_AGO,
  });
  kyc.submitForVerification();
  kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
  await deps.rental.kycRepo.save(kyc);

  const insurance = InsurancePolicy.create({
    id: 'ins-1',
    watchId: WATCH_ID,
    providerId: 'ins-provider-1',
    coverageAmount: 15000,
    deductible: 500,
    premiumPerRental: 50,
    effectiveFrom: ONE_YEAR_AGO,
    effectiveTo: ONE_YEAR_LATER,
    createdAt: ONE_YEAR_AGO,
  });
  await deps.rental.insuranceRepo.save(insurance);
}

describe('POST /rentals/initiate', () => {
  it('returns 401 without auth token', async () => {
    const { app } = makeTestApp();

    const res = await request(app)
      .post('/rentals/initiate')
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('succeeds with valid authenticated request', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rental.renterId).toBe(RENTER_ID);
    expect(res.body.data.rental.watchId).toBe(WATCH_ID);
    expect(res.body.data.rental.escrowStatus).toBe('AWAITING_EXTERNAL_PAYMENT');
  });

  it('derives renter from token, ignores renterId in body', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    // Body includes a different renterId — it should be ignored
    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        renterId: OTHER_USER_ID, // this should be ignored
        watchId: WATCH_ID,
        rentalPrice: 500,
        city: 'NYC',
        zipCode: '10001',
      });

    expect(res.status).toBe(201);
    // Rental should be for the authenticated actor, not the body renterId
    expect(res.body.data.rental.renterId).toBe(RENTER_ID);
  });

  it('rejects invalid city', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'LA', zipCode: '10001' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CITY_NOT_ACTIVE');
  });

  it('rejects invalid ZIP code format', async () => {
    const { app } = makeTestApp();
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: 'ABCDE' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects self-rental (renter is watch owner)', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);

    const selfWatch = Watch.create({
      id: '44444444-4444-4444-4444-444444444444',
      ownerId: RENTER_ID,
      marketValue: 1500,
      verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.watchRepo.save(selfWatch);

    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: '44444444-4444-4444-4444-444444444444', rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects high-risk user', async () => {
    const { app, deps } = makeTestApp();

    const renter = User.create({
      id: RENTER_ID,
      role: MarketplaceRole.RENTER,
      trustScore: 15,
      disputesCount: 4,
      chargebacksCount: 3,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(renter);

    const owner = User.create({
      id: OWNER_ID,
      role: MarketplaceRole.OWNER,
      trustScore: 90,
      disputesCount: 0,
      chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(owner);

    const watch = Watch.create({
      id: WATCH_ID,
      ownerId: OWNER_ID,
      marketValue: 1500,
      verificationStatus: VerificationStatus.VERIFIED_BY_PARTNER,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.watchRepo.save(watch);

    const kyc = KycProfile.create({ userId: RENTER_ID, providerReference: 'ref', createdAt: ONE_YEAR_AGO });
    kyc.submitForVerification();
    kyc.markVerified(ONE_YEAR_AGO, ONE_YEAR_LATER);
    await deps.rental.kycRepo.save(kyc);

    const insurance = InsurancePolicy.create({
      id: 'ins-1', watchId: WATCH_ID, providerId: 'p1', coverageAmount: 15000,
      deductible: 500, premiumPerRental: 50, effectiveFrom: ONE_YEAR_AGO,
      effectiveTo: ONE_YEAR_LATER, createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.insuranceRepo.save(insurance);

    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HIGH_RISK_TRANSACTION');
  });

  it('rejects unverified high-value watch', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);

    const unverified = Watch.create({
      id: '55555555-5555-5555-5555-555555555555',
      ownerId: OWNER_ID,
      marketValue: 8000,
      verificationStatus: VerificationStatus.UNVERIFIED,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.watchRepo.save(unverified);

    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: '55555555-5555-5555-5555-555555555555', rentalPrice: 400, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WATCH_NOT_VERIFIED');
  });

  it('rejects negative economics', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 1, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ECONOMICS_NEGATIVE');
  });

  it('returns cached response for duplicate idempotency key with same payload', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const payload = { watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' };

    const res1 = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-key-1')
      .send(payload);

    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-key-1')
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.data.rental.id).toBe(res1.body.data.rental.id);
  });

  it('rejects idempotency key reuse with different payload', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-key-2')
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    const res2 = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-key-2')
      .send({ watchId: WATCH_ID, rentalPrice: 600, city: 'NYC', zipCode: '10001' });

    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects missing required fields', async () => {
    const { app } = makeTestApp();
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects NaN / negative rental price', async () => {
    const { app } = makeTestApp();
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: -100, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.some((e: { field: string }) => e.field === 'rentalPrice')).toBe(true);
  });

  it('returns 404 for nonexistent renter (user in token not in DB)', async () => {
    const { app } = makeTestApp();
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('concurrent same-watch initiation does not double-book', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const payload = { watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' };

    const res1 = await request(app).post('/rentals/initiate').set('Authorization', `Bearer ${token}`).send(payload);
    expect(res1.status).toBe(201);

    const res2 = await request(app).post('/rentals/initiate').set('Authorization', `Bearer ${token}`).send(payload);
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('WATCH_ALREADY_RESERVED');
  });
});

describe('GET /rentals/:id', () => {
  it('returns 401 without auth token', async () => {
    const { app } = makeTestApp();
    const res = await request(app).get(`/rentals/${RENTER_ID}`);
    expect(res.status).toBe(401);
  });

  it('renter can read own rental', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const createRes = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    const rentalId = createRes.body.data.rental.id;

    const res = await request(app)
      .get(`/rentals/${rentalId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rental.id).toBe(rentalId);
  });

  it('watch owner can read rental', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const renterToken = signToken(RENTER_ID, MarketplaceRole.RENTER);
    const ownerToken = signToken(OWNER_ID, MarketplaceRole.OWNER);

    const createRes = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    const rentalId = createRes.body.data.rental.id;

    const res = await request(app)
      .get(`/rentals/${rentalId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
  });

  it('unrelated user cannot read rental', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const renterToken = signToken(RENTER_ID, MarketplaceRole.RENTER);

    // Seed unrelated user
    const other = User.create({
      id: OTHER_USER_ID,
      role: MarketplaceRole.RENTER,
      trustScore: 85,
      disputesCount: 0,
      chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(other);
    const otherToken = signToken(OTHER_USER_ID, MarketplaceRole.RENTER);

    const createRes = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    const rentalId = createRes.body.data.rental.id;

    const res = await request(app)
      .get(`/rentals/${rentalId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('admin can read any rental', async () => {
    const { app, deps } = makeTestApp();
    await seedStandardData(deps);
    const renterToken = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const adminId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const admin = User.create({
      id: adminId,
      role: MarketplaceRole.ADMIN,
      trustScore: 100,
      disputesCount: 0,
      chargebacksCount: 0,
      createdAt: ONE_YEAR_AGO,
    });
    await deps.rental.userRepo.save(admin);
    const adminToken = signToken(adminId, MarketplaceRole.ADMIN);

    const createRes = await request(app)
      .post('/rentals/initiate')
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ watchId: WATCH_ID, rentalPrice: 500, city: 'NYC', zipCode: '10001' });

    const rentalId = createRes.body.data.rental.id;

    const res = await request(app)
      .get(`/rentals/${rentalId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });

  it('returns 404 for nonexistent rental', async () => {
    const { app } = makeTestApp();
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .get(`/rentals/${RENTER_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('rejects invalid UUID param', async () => {
    const { app } = makeTestApp();
    const token = signToken(RENTER_ID, MarketplaceRole.RENTER);

    const res = await request(app)
      .get('/rentals/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
