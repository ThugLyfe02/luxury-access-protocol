import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeTestApp } from './testAppFactory';
import { signToken } from './testAuthHelper';
import { MarketplaceRole } from '../../src/domain/enums/MarketplaceRole';
import { ManualReviewCase } from '../../src/domain/entities/ManualReviewCase';
import { ReviewSeverity } from '../../src/domain/enums/ReviewSeverity';
import { InMemoryManualReviewRepository } from '../../src/infrastructure/repositories/InMemoryManualReviewRepository';
import { InMemoryFreezeRepository } from '../../src/infrastructure/repositories/InMemoryFreezeRepository';
import { InMemoryAuditLogRepository } from '../../src/infrastructure/repositories/InMemoryAuditLogRepository';
import { AdminControlService } from '../../src/application/services/AdminControlService';
import { Express } from 'express';
import { AppDeps } from '../../src/http/app';

describe('Admin Routes', () => {
  let app: Express;
  let deps: AppDeps;
  let reviewRepo: InMemoryManualReviewRepository;
  let freezeRepo: InMemoryFreezeRepository;
  let auditLogRepo: InMemoryAuditLogRepository;
  let adminToken: string;
  let renterToken: string;

  beforeEach(() => {
    const testApp = makeTestApp();
    app = testApp.app;
    deps = testApp.deps;

    // Access the repos through the admin deps
    // We need to create fresh ones for direct access in tests
    reviewRepo = new InMemoryManualReviewRepository();
    freezeRepo = new InMemoryFreezeRepository();
    auditLogRepo = new InMemoryAuditLogRepository();

    const adminService = new AdminControlService(freezeRepo, auditLogRepo, reviewRepo);

    // We need to rebuild the app with our repos for inspection
    // Actually, let's just use the app's built-in admin service
    adminToken = signToken('admin-1', MarketplaceRole.ADMIN);
    renterToken = signToken('renter-1', MarketplaceRole.RENTER);
  });

  describe('POST /admin/freeze', () => {
    it('returns 201 for admin creating a freeze', async () => {
      const res = await request(app)
        .post('/admin/freeze')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entityType: 'USER',
          entityId: 'user-1',
          reason: 'Suspicious activity',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.active).toBe(true);
      expect(res.body.data.entityType).toBe('USER');
    });

    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/admin/freeze')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({
          entityType: 'USER',
          entityId: 'user-1',
          reason: 'Suspicious',
        });

      expect(res.status).toBe(403);
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post('/admin/freeze')
        .send({
          entityType: 'USER',
          entityId: 'user-1',
          reason: 'Suspicious',
        });

      expect(res.status).toBe(401);
    });

    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .post('/admin/freeze')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ entityType: 'USER' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid entity type', async () => {
      const res = await request(app)
        .post('/admin/freeze')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entityType: 'INVALID',
          entityId: 'user-1',
          reason: 'Suspicious',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /admin/unfreeze', () => {
    it('returns 200 for admin unfreezing', async () => {
      // First create a freeze
      const createRes = await request(app)
        .post('/admin/freeze')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          entityType: 'WATCH',
          entityId: 'watch-1',
          reason: 'Under investigation',
        });

      const freezeId = createRes.body.data.freezeId;

      const res = await request(app)
        .post('/admin/unfreeze')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ freezeId });

      expect(res.status).toBe(200);
      expect(res.body.data.unfrozen).toBe(true);
    });

    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/admin/unfreeze')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({ freezeId: 'freeze-1' });

      expect(res.status).toBe(403);
    });

    it('returns 400 for missing freezeId', async () => {
      const res = await request(app)
        .post('/admin/unfreeze')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /admin/review/assign', () => {
    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .post('/admin/review/assign')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewId: 'review-1' });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/admin/review/assign')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({
          reviewId: 'review-1',
          assigneeId: 'admin-2',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/review/approve', () => {
    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .post('/admin/review/approve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewId: 'review-1' });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/admin/review/approve')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({
          reviewId: 'review-1',
          resolution: 'OK',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/review/reject', () => {
    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .post('/admin/review/reject')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewId: 'review-1' });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/admin/review/reject')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({
          reviewId: 'review-1',
          resolution: 'Denied',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/review/note', () => {
    it('returns 400 for missing fields', async () => {
      const res = await request(app)
        .post('/admin/review/note')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviewId: 'review-1' });

      expect(res.status).toBe(400);
    });

    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/admin/review/note')
        .set('Authorization', `Bearer ${renterToken}`)
        .send({
          reviewId: 'review-1',
          note: 'A note',
        });

      expect(res.status).toBe(403);
    });
  });
});
