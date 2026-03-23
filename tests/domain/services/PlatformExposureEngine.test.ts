import { describe, it, expect } from 'vitest';
import { PlatformExposureEngine, ExposureConfig, ExposureSnapshot } from '../../../src/domain/services/PlatformExposureEngine';
import { DomainError } from '../../../src/domain/errors/DomainError';

const VALID_CONFIG: ExposureConfig = {
  capitalReserve: 500_000,
  maxExposureToCapitalRatio: 3.0,
  maxSingleWatchUncoveredExposure: 50_000,
  maxActiveRentals: 100,
};

const EMPTY_SNAPSHOT: ExposureSnapshot = {
  totalActiveWatchValue: 0,
  totalInsuranceCoverage: 0,
  activeRentalCount: 0,
};

describe('PlatformExposureEngine', () => {
  describe('validateConfig', () => {
    it('accepts valid config', () => {
      expect(() => PlatformExposureEngine.validateConfig(VALID_CONFIG)).not.toThrow();
    });

    it('rejects zero capital reserve', () => {
      expect(() => PlatformExposureEngine.validateConfig({ ...VALID_CONFIG, capitalReserve: 0 })).toThrow(DomainError);
    });

    it('rejects negative capital reserve', () => {
      expect(() => PlatformExposureEngine.validateConfig({ ...VALID_CONFIG, capitalReserve: -1 })).toThrow(DomainError);
    });

    it('rejects NaN values', () => {
      expect(() => PlatformExposureEngine.validateConfig({ ...VALID_CONFIG, capitalReserve: NaN })).toThrow(DomainError);
    });

    it('rejects non-integer maxActiveRentals', () => {
      expect(() => PlatformExposureEngine.validateConfig({ ...VALID_CONFIG, maxActiveRentals: 10.5 })).toThrow(DomainError);
    });
  });

  describe('assertRentalWithinExposureLimits', () => {
    it('allows rental within all limits', () => {
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, EMPTY_SNAPSHOT,
          { watchMarketValue: 10000, insuranceCoverage: 8000 },
        ),
      ).not.toThrow();
    });

    it('blocks when active rental count at max', () => {
      const fullSnapshot: ExposureSnapshot = { ...EMPTY_SNAPSHOT, activeRentalCount: 100 };
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, fullSnapshot,
          { watchMarketValue: 1000, insuranceCoverage: 0 },
        ),
      ).toThrow(DomainError);
      try {
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, fullSnapshot, { watchMarketValue: 1000, insuranceCoverage: 0 },
        );
      } catch (e) {
        expect((e as DomainError).code).toBe('PLATFORM_EXPOSURE_LIMIT');
      }
    });

    it('blocks single-watch uncovered exposure exceeding cap', () => {
      // watch=60000, insurance=0 → uncovered=60000 > cap=50000
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, EMPTY_SNAPSHOT,
          { watchMarketValue: 60000, insuranceCoverage: 0 },
        ),
      ).toThrow(DomainError);
      try {
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, EMPTY_SNAPSHOT, { watchMarketValue: 60000, insuranceCoverage: 0 },
        );
      } catch (e) {
        expect((e as DomainError).code).toBe('RISK_EXCEEDS_CAP');
      }
    });

    it('allows single-watch when insurance brings uncovered under cap', () => {
      // watch=60000, insurance=15000 → uncovered=45000 < cap=50000
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, EMPTY_SNAPSHOT,
          { watchMarketValue: 60000, insuranceCoverage: 15000 },
        ),
      ).not.toThrow();
    });

    it('blocks when aggregate exposure exceeds capital ratio', () => {
      // config: reserve=500k, ratio=3 → max exposure=1.5M
      // current: totalValue=1.5M, insurance=0 → uncovered=1.5M
      // proposed: watchValue=50k, insurance=0 → proposedUncovered=50k
      // total projected: 1.5M + 50k = 1.55M > 1.5M cap → blocked
      const heavySnapshot: ExposureSnapshot = {
        totalActiveWatchValue: 1_500_000,
        totalInsuranceCoverage: 0,
        activeRentalCount: 50,
      };
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, heavySnapshot,
          { watchMarketValue: 50000, insuranceCoverage: 0 },
        ),
      ).toThrow(DomainError);
      try {
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, heavySnapshot, { watchMarketValue: 50000, insuranceCoverage: 0 },
        );
      } catch (e) {
        expect((e as DomainError).code).toBe('PLATFORM_EXPOSURE_LIMIT');
      }
    });

    it('rejects zero watch market value', () => {
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, EMPTY_SNAPSHOT,
          { watchMarketValue: 0, insuranceCoverage: 0 },
        ),
      ).toThrow(DomainError);
    });

    it('rejects negative insurance coverage', () => {
      expect(() =>
        PlatformExposureEngine.assertRentalWithinExposureLimits(
          VALID_CONFIG, EMPTY_SNAPSHOT,
          { watchMarketValue: 1000, insuranceCoverage: -1 },
        ),
      ).toThrow(DomainError);
    });
  });

  describe('computeUncoveredExposure', () => {
    it('returns value minus coverage', () => {
      expect(PlatformExposureEngine.computeUncoveredExposure({
        totalActiveWatchValue: 100000, totalInsuranceCoverage: 30000, activeRentalCount: 5,
      })).toBe(70000);
    });

    it('floors at zero when coverage exceeds value', () => {
      expect(PlatformExposureEngine.computeUncoveredExposure({
        totalActiveWatchValue: 10000, totalInsuranceCoverage: 50000, activeRentalCount: 1,
      })).toBe(0);
    });
  });
});
