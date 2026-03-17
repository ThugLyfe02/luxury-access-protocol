import { describe, it, expect } from 'vitest';
import { UnitEconomicsGuard } from '../../../src/domain/services/UnitEconomicsGuard';
import { DomainError } from '../../../src/domain/errors/DomainError';

describe('UnitEconomicsGuard', () => {
  describe('assertRentalEconomicsViable', () => {
    it('passes for a healthy rental', () => {
      // rentalCharge=2000, watchValue=10000, platformGross=400 (20%)
      // processing: 2000*0.029 + 0.30 = 58.30
      // lossBuffer: 10000*0.002 = 20
      // marginFloor: max(75, 400*0.15=60) = 75
      // net: 400 - 58.30 - 20 = 321.70 > 75 ✓
      expect(() =>
        UnitEconomicsGuard.assertRentalEconomicsViable(2000, 10000, 400),
      ).not.toThrow();
    });

    it('blocks when net margin is below floor', () => {
      // rentalCharge=100, watchValue=50000, platformGross=20
      // processing: 100*0.029 + 0.30 = 3.20
      // lossBuffer: 50000*0.002 = 100
      // marginFloor: max(75, 20*0.15=3) = 75
      // net: 20 - 3.20 - 100 = -83.20 < 75 ✗
      expect(() =>
        UnitEconomicsGuard.assertRentalEconomicsViable(100, 50000, 20),
      ).toThrow(DomainError);
      try {
        UnitEconomicsGuard.assertRentalEconomicsViable(100, 50000, 20);
      } catch (e) {
        expect((e as DomainError).code).toBe('ECONOMICS_NEGATIVE');
      }
    });

    it('blocks zero rental charge', () => {
      expect(() =>
        UnitEconomicsGuard.assertRentalEconomicsViable(0, 1000, 100),
      ).toThrow(DomainError);
    });

    it('blocks negative rental charge', () => {
      expect(() =>
        UnitEconomicsGuard.assertRentalEconomicsViable(-100, 1000, 100),
      ).toThrow(DomainError);
    });

    it('blocks NaN inputs', () => {
      expect(() =>
        UnitEconomicsGuard.assertRentalEconomicsViable(NaN, 1000, 100),
      ).toThrow(DomainError);
    });

    it('blocks Infinity inputs', () => {
      expect(() =>
        UnitEconomicsGuard.assertRentalEconomicsViable(Infinity, 1000, 100),
      ).toThrow(DomainError);
    });
  });

  describe('computeBreakdown', () => {
    it('returns correct breakdown values', () => {
      const result = UnitEconomicsGuard.computeBreakdown(1000, 5000, 200);
      expect(result.processingFees).toBeCloseTo(29.30, 2);  // 1000*0.029 + 0.30
      expect(result.lossBuffer).toBeCloseTo(10, 2);          // 5000*0.002
      expect(result.marginFloor).toBe(75);                    // max(75, 200*0.15=30)
      expect(result.netAfterCosts).toBeCloseTo(160.70, 2);   // 200 - 29.30 - 10
      expect(result.passes).toBe(true);                       // 160.70 >= 75
    });

    it('returns passes=false for invalid inputs', () => {
      const result = UnitEconomicsGuard.computeBreakdown(0, 1000, 100);
      expect(result.passes).toBe(false);
    });
  });
});
