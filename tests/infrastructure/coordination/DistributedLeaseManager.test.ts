import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DistributedLeaseManager } from '../../../src/infrastructure/coordination/DistributedLeaseManager';

const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

describe('DistributedLeaseManager', () => {
  let manager: DistributedLeaseManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new DistributedLeaseManager();
  });

  const leaseRow = {
    lease_name: 'reconciliation-sweep',
    owner_id: 'worker-1',
    acquired_at: '2025-01-01T00:00:00Z',
    renewed_at: '2025-01-01T00:00:00Z',
    lease_until: '2025-01-01T00:10:00Z',
    version: 1,
    metadata: null,
  };

  describe('acquire', () => {
    it('acquires a lease successfully', async () => {
      // Delete expired (none)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Insert succeeds
      mockQuery.mockResolvedValueOnce({ rows: [leaseRow], rowCount: 1 });

      const lease = await manager.acquire({
        leaseName: 'reconciliation-sweep',
        ownerId: 'worker-1',
        ttlMs: 600_000,
      });

      expect(lease).not.toBeNull();
      expect(lease!.leaseName).toBe('reconciliation-sweep');
      expect(lease!.ownerId).toBe('worker-1');
    });

    it('returns null when lease already held', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const lease = await manager.acquire({
        leaseName: 'reconciliation-sweep',
        ownerId: 'worker-2',
        ttlMs: 600_000,
      });

      expect(lease).toBeNull();
    });

    it('cleans up expired lease before acquiring', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // deleted expired
      mockQuery.mockResolvedValueOnce({ rows: [leaseRow], rowCount: 1 });

      const lease = await manager.acquire({
        leaseName: 'reconciliation-sweep',
        ownerId: 'worker-1',
        ttlMs: 600_000,
      });

      expect(lease).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const [deleteSQL] = mockQuery.mock.calls[0];
      expect(deleteSQL).toContain('DELETE FROM distributed_leases');
      expect(deleteSQL).toContain('lease_until < now()');
    });

    it('passes metadata as JSON', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({ rows: [{ ...leaseRow, metadata: { foo: 'bar' } }], rowCount: 1 });

      await manager.acquire({
        leaseName: 'test-lease',
        ownerId: 'worker-1',
        ttlMs: 60_000,
        metadata: { foo: 'bar' },
      });

      const [, insertParams] = mockQuery.mock.calls[1];
      expect(JSON.parse(insertParams[3])).toEqual({ foo: 'bar' });
    });
  });

  describe('renew', () => {
    it('renews a lease successfully', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...leaseRow, version: 2, renewed_at: '2025-01-01T00:05:00Z' }],
        rowCount: 1,
      });

      const renewed = await manager.renew('reconciliation-sweep', 'worker-1', 600_000);

      expect(renewed).not.toBeNull();
      expect(renewed!.version).toBe(2);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('owner_id = $2');
      expect(sql).toContain('lease_until > now()');
    });

    it('returns null when lease expired or owner changed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const renewed = await manager.renew('reconciliation-sweep', 'worker-1', 600_000);

      expect(renewed).toBeNull();
    });
  });

  describe('release', () => {
    it('releases a lease owned by the caller', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const released = await manager.release('reconciliation-sweep', 'worker-1');

      expect(released).toBe(true);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM distributed_leases');
      expect(params[0]).toBe('reconciliation-sweep');
      expect(params[1]).toBe('worker-1');
    });

    it('returns false when not the owner', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const released = await manager.release('reconciliation-sweep', 'wrong-worker');

      expect(released).toBe(false);
    });
  });

  describe('releaseAll', () => {
    it('releases all leases for a given owner', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });

      const count = await manager.releaseAll('worker-1');

      expect(count).toBe(3);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM distributed_leases');
      expect(params[0]).toBe('worker-1');
    });
  });

  describe('get', () => {
    it('returns the current lease holder', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [leaseRow] });

      const lease = await manager.get('reconciliation-sweep');

      expect(lease).not.toBeNull();
      expect(lease!.ownerId).toBe('worker-1');
    });

    it('returns null when no active lease', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const lease = await manager.get('reconciliation-sweep');

      expect(lease).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns all active leases', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [leaseRow, { ...leaseRow, lease_name: 'other-lease', owner_id: 'worker-2' }],
      });

      const leases = await manager.getAll();

      expect(leases).toHaveLength(2);
    });
  });
});
