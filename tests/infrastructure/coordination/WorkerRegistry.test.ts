import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerRegistry } from '../../../src/infrastructure/coordination/WorkerRegistry';

// Mock the database connection
const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/db/connection', () => ({
  getPool: () => ({ query: mockQuery }),
}));

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new WorkerRegistry(30_000);
  });

  describe('register', () => {
    it('inserts a new worker registration', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await registry.register('host-123-1000', 'outbox', { version: '1.0' });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO worker_registrations');
      expect(sql).toContain('ON CONFLICT');
      expect(params[0]).toBe('host-123-1000');
      expect(params[1]).toBe('outbox');
      expect(JSON.parse(params[2])).toEqual({ version: '1.0' });
    });

    it('passes null metadata when none provided', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await registry.register('host-123-1000', 'api');

      const [, params] = mockQuery.mock.calls[0];
      expect(params[2]).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('updates heartbeat_at for a running worker', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await registry.heartbeat('host-123-1000');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE worker_registrations SET heartbeat_at');
      expect(params[0]).toBe('host-123-1000');
    });
  });

  describe('deregister', () => {
    it('marks worker as STOPPED', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await registry.deregister('host-123-1000');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("SET status = 'STOPPED'");
      expect(params[0]).toBe('host-123-1000');
    });
  });

  describe('findStaleWorkers', () => {
    it('queries for workers with old heartbeats', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          worker_id: 'old-worker',
          worker_type: 'outbox',
          started_at: '2025-01-01T00:00:00Z',
          heartbeat_at: '2025-01-01T00:00:00Z',
          status: 'RUNNING',
          metadata: null,
        }],
      });

      const stale = await registry.findStaleWorkers(120_000);

      expect(stale).toHaveLength(1);
      expect(stale[0].workerId).toBe('old-worker');
      expect(stale[0].status).toBe('RUNNING');
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("status = 'RUNNING'");
      expect(params[0]).toBe(120_000);
    });
  });

  describe('markStaleWorkers', () => {
    it('updates stale workers to STALE status', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 2 });

      const count = await registry.markStaleWorkers(120_000);

      expect(count).toBe(2);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("SET status = 'STALE'");
    });
  });

  describe('getAll', () => {
    it('returns all registered workers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            worker_id: 'w1',
            worker_type: 'api',
            started_at: '2025-01-01T00:00:00Z',
            heartbeat_at: '2025-01-01T00:01:00Z',
            status: 'RUNNING',
            metadata: { port: 3000 },
          },
          {
            worker_id: 'w2',
            worker_type: 'outbox',
            started_at: '2025-01-01T00:00:00Z',
            heartbeat_at: '2025-01-01T00:01:00Z',
            status: 'STOPPED',
            metadata: null,
          },
        ],
      });

      const workers = await registry.getAll();

      expect(workers).toHaveLength(2);
      expect(workers[0].workerId).toBe('w1');
      expect(workers[0].workerType).toBe('api');
      expect(workers[0].metadata).toEqual({ port: 3000 });
      expect(workers[1].workerId).toBe('w2');
      expect(workers[1].status).toBe('STOPPED');
    });
  });

  describe('getRunning', () => {
    it('returns only RUNNING workers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          worker_id: 'w1',
          worker_type: 'api',
          started_at: '2025-01-01T00:00:00Z',
          heartbeat_at: '2025-01-01T00:01:00Z',
          status: 'RUNNING',
          metadata: null,
        }],
      });

      const workers = await registry.getRunning();

      expect(workers).toHaveLength(1);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("status = 'RUNNING'");
    });
  });

  describe('cleanupStopped', () => {
    it('deletes old STOPPED/STALE entries', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });

      const count = await registry.cleanupStopped(86_400_000);

      expect(count).toBe(5);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("status IN ('STOPPED', 'STALE')");
      expect(params[0]).toBe(86_400_000);
    });
  });

  describe('heartbeat timer', () => {
    it('starts and stops periodic heartbeat', () => {
      vi.useFakeTimers();
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      registry.startHeartbeat('w1');

      // Advance past one interval
      vi.advanceTimersByTime(30_001);
      expect(mockQuery).toHaveBeenCalled();

      registry.stopHeartbeat();
      const callCount = mockQuery.mock.calls.length;

      // Advance further — no new calls
      vi.advanceTimersByTime(60_000);
      expect(mockQuery.mock.calls.length).toBe(callCount);

      vi.useRealTimers();
    });
  });
});
