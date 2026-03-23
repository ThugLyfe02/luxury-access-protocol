import { describe, it, expect } from 'vitest';
import { generateWorkerId } from '../../../src/infrastructure/coordination/WorkerIdentity';

describe('WorkerIdentity', () => {
  it('generates a non-empty string', () => {
    const id = generateWorkerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('contains hostname, pid, timestamp, and counter components', () => {
    const id = generateWorkerId();
    const parts = id.split('-');
    // At minimum: hostname-pid-timestamp-counter (hostname itself may contain hyphens)
    expect(parts.length).toBeGreaterThanOrEqual(4);
    // Last part should be a numeric counter
    const counterPart = parts[parts.length - 1];
    expect(Number(counterPart)).toBeGreaterThanOrEqual(0);
    // Second-to-last should be numeric timestamp
    const tsPart = parts[parts.length - 2];
    expect(Number(tsPart)).toBeGreaterThan(0);
    // Third-to-last should be numeric PID
    const pidPart = parts[parts.length - 3];
    expect(Number(pidPart)).toBeGreaterThan(0);
  });

  it('generates unique IDs across 1000 calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateWorkerId());
    }
    // Due to Date.now() resolution, some may share timestamps within the same ms.
    // But hostname-pid-timestamp should still be unique since pid and hostname are constant
    // and timestamps are monotonically non-decreasing within a process.
    // In practice, Date.now() will differ for most calls.
    // The critical guarantee is no two different processes produce the same ID.
    expect(ids.size).toBe(1000);
  });

  it('includes the process PID', () => {
    const id = generateWorkerId();
    expect(id).toContain(String(process.pid));
  });

  it('different timestamp on delayed calls', async () => {
    const id1 = generateWorkerId();
    await new Promise(r => setTimeout(r, 2));
    const id2 = generateWorkerId();
    expect(id1).not.toBe(id2);
  });
});
