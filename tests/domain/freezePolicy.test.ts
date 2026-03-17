import { describe, it, expect } from 'vitest';
import { FreezePolicy } from '../../src/domain/services/FreezePolicy';
import { SystemFreeze } from '../../src/domain/entities/SystemFreeze';
import { DomainError } from '../../src/domain/errors/DomainError';

function makeFreeze(overrides?: {
  entityType?: 'USER' | 'WATCH' | 'RENTAL';
  entityId?: string;
  active?: boolean;
}): SystemFreeze {
  const f = SystemFreeze.create({
    id: 'freeze-1',
    entityType: overrides?.entityType ?? 'USER',
    entityId: overrides?.entityId ?? 'user-1',
    reason: 'Suspicious activity',
    frozenBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
  });

  if (overrides?.active === false) {
    f.deactivate();
  }
  return f;
}

describe('FreezePolicy', () => {
  describe('ensureNotFrozen', () => {
    it('passes when no active freezes exist', () => {
      expect(() =>
        FreezePolicy.ensureNotFrozen('USER', 'user-1', []),
      ).not.toThrow();
    });

    it('passes when freeze exists for different entity', () => {
      const f = makeFreeze({ entityId: 'user-2' });
      expect(() =>
        FreezePolicy.ensureNotFrozen('USER', 'user-1', [f]),
      ).not.toThrow();
    });

    it('passes when freeze exists for different type', () => {
      const f = makeFreeze({ entityType: 'WATCH', entityId: 'watch-1' });
      expect(() =>
        FreezePolicy.ensureNotFrozen('USER', 'user-1', [f]),
      ).not.toThrow();
    });

    it('passes when freeze is inactive', () => {
      const f = makeFreeze({ active: false });
      expect(() =>
        FreezePolicy.ensureNotFrozen('USER', 'user-1', [f]),
      ).not.toThrow();
    });

    it('throws FROZEN_ENTITY when active freeze matches', () => {
      const f = makeFreeze();
      expect(() =>
        FreezePolicy.ensureNotFrozen('USER', 'user-1', [f]),
      ).toThrow(DomainError);

      try {
        FreezePolicy.ensureNotFrozen('USER', 'user-1', [f]);
      } catch (e) {
        expect((e as DomainError).code).toBe('FROZEN_ENTITY');
      }
    });

    it('blocks rental when rental is frozen', () => {
      const f = makeFreeze({ entityType: 'RENTAL', entityId: 'rental-1' });
      expect(() =>
        FreezePolicy.ensureNotFrozen('RENTAL', 'rental-1', [f]),
      ).toThrow(DomainError);
    });

    it('blocks watch when watch is frozen', () => {
      const f = makeFreeze({ entityType: 'WATCH', entityId: 'watch-1' });
      expect(() =>
        FreezePolicy.ensureNotFrozen('WATCH', 'watch-1', [f]),
      ).toThrow(DomainError);
    });
  });
});

describe('SystemFreeze', () => {
  it('creates as active', () => {
    const f = makeFreeze();
    expect(f.active).toBe(true);
  });

  it('deactivates', () => {
    const f = makeFreeze();
    f.deactivate();
    expect(f.active).toBe(false);
  });

  it('throws on double deactivate', () => {
    const f = makeFreeze();
    f.deactivate();
    expect(() => f.deactivate()).toThrow(DomainError);
  });

  it('rejects missing fields', () => {
    expect(() =>
      SystemFreeze.create({
        id: '',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'reason',
        frozenBy: 'admin-1',
        createdAt: new Date(),
      }),
    ).toThrow(DomainError);

    expect(() =>
      SystemFreeze.create({
        id: 'id',
        entityType: 'USER',
        entityId: '',
        reason: 'reason',
        frozenBy: 'admin-1',
        createdAt: new Date(),
      }),
    ).toThrow(DomainError);

    expect(() =>
      SystemFreeze.create({
        id: 'id',
        entityType: 'USER',
        entityId: 'user-1',
        reason: '',
        frozenBy: 'admin-1',
        createdAt: new Date(),
      }),
    ).toThrow(DomainError);

    expect(() =>
      SystemFreeze.create({
        id: 'id',
        entityType: 'USER',
        entityId: 'user-1',
        reason: 'reason',
        frozenBy: '',
        createdAt: new Date(),
      }),
    ).toThrow(DomainError);
  });

  it('rejects invalid entity type on restore', () => {
    expect(() =>
      SystemFreeze.restore({
        id: 'id',
        entityType: 'INVALID',
        entityId: 'e-1',
        reason: 'reason',
        frozenBy: 'admin-1',
        createdAt: new Date(),
        active: true,
      }),
    ).toThrow(DomainError);
  });
});
