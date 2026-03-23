import { describe, it, expect } from 'vitest';
import { CompliancePolicy } from '../../../src/domain/services/CompliancePolicy';
import { DomainError } from '../../../src/domain/errors/DomainError';

describe('CompliancePolicy', () => {
  describe('ensureCityActive', () => {
    it('accepts NYC', () => {
      expect(() => CompliancePolicy.ensureCityActive('NYC')).not.toThrow();
    });

    it('accepts NYC case-insensitively', () => {
      expect(() => CompliancePolicy.ensureCityActive('nyc')).not.toThrow();
      expect(() => CompliancePolicy.ensureCityActive('Nyc')).not.toThrow();
    });

    it('accepts NYC with whitespace', () => {
      expect(() => CompliancePolicy.ensureCityActive('  NYC  ')).not.toThrow();
    });

    it('rejects non-NYC cities', () => {
      for (const city of ['LA', 'Chicago', 'Miami', 'London', 'SF']) {
        expect(() => CompliancePolicy.ensureCityActive(city)).toThrow(DomainError);
        try {
          CompliancePolicy.ensureCityActive(city);
        } catch (e) {
          expect((e as DomainError).code).toBe('CITY_NOT_ACTIVE');
        }
      }
    });

    it('rejects empty string', () => {
      expect(() => CompliancePolicy.ensureCityActive('')).toThrow(DomainError);
    });
  });

  describe('ensureZipMatchesCity', () => {
    it('accepts valid NYC ZIP codes', () => {
      const validZips = ['10001', '10010', '10036', '10128', '11101', '11201', '11499'];
      for (const zip of validZips) {
        expect(() => CompliancePolicy.ensureZipMatchesCity(zip, 'NYC')).not.toThrow();
      }
    });

    it('accepts boundary ZIP codes (100xx and 114xx)', () => {
      expect(() => CompliancePolicy.ensureZipMatchesCity('10000', 'NYC')).not.toThrow();
      expect(() => CompliancePolicy.ensureZipMatchesCity('11499', 'NYC')).not.toThrow();
    });

    it('rejects ZIP codes outside NYC range', () => {
      const invalidZips = ['09999', '11500', '20001', '90210', '60601'];
      for (const zip of invalidZips) {
        expect(() => CompliancePolicy.ensureZipMatchesCity(zip, 'NYC')).toThrow(DomainError);
        try {
          CompliancePolicy.ensureZipMatchesCity(zip, 'NYC');
        } catch (e) {
          expect((e as DomainError).code).toBe('CITY_NOT_ACTIVE');
        }
      }
    });

    it('rejects non-5-digit ZIP codes', () => {
      expect(() => CompliancePolicy.ensureZipMatchesCity('1001', 'NYC')).toThrow(DomainError);
      expect(() => CompliancePolicy.ensureZipMatchesCity('100012', 'NYC')).toThrow(DomainError);
      expect(() => CompliancePolicy.ensureZipMatchesCity('ABCDE', 'NYC')).toThrow(DomainError);
      expect(() => CompliancePolicy.ensureZipMatchesCity('', 'NYC')).toThrow(DomainError);
    });

    it('skips ZIP validation for non-NYC cities (compliance gate is at city level)', () => {
      // Non-NYC cities don't get ZIP-checked — they fail at ensureCityActive
      expect(() => CompliancePolicy.ensureZipMatchesCity('90210', 'LA')).not.toThrow();
    });
  });
});
