import { describe, it, expect } from 'vitest';
import { DomainError } from '../../../src/domain/errors/DomainError';
import { isDomainErrorCode } from '../../../src/domain/errors/ErrorCodes';

describe('DomainError', () => {
  it('extends Error', () => {
    const err = new DomainError('test', 'UNAUTHORIZED');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DomainError);
  });

  it('preserves message and code', () => {
    const err = new DomainError('something broke', 'CUSTODY_VIOLATION');
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('CUSTODY_VIOLATION');
    expect(err.name).toBe('DomainError');
  });

  it('has correct prototype chain after setPrototypeOf', () => {
    const err = new DomainError('x', 'UNAUTHORIZED');
    expect(Object.getPrototypeOf(err)).toBe(DomainError.prototype);
  });
});

describe('ErrorCodes', () => {
  it('isDomainErrorCode returns true for known codes', () => {
    const knownCodes = [
      'INVALID_OWNER', 'INVALID_VALUATION', 'UNAUTHORIZED',
      'INVALID_ESCROW_TRANSITION', 'CUSTODY_VIOLATION', 'KYC_REQUIRED',
      'CITY_NOT_ACTIVE', 'ECONOMICS_NEGATIVE', 'PLATFORM_EXPOSURE_LIMIT',
      'RETURN_NOT_CONFIRMED', 'DISPUTE_LOCK', 'REVIEW_REQUIRED',
    ];
    for (const code of knownCodes) {
      expect(isDomainErrorCode(code)).toBe(true);
    }
  });

  it('isDomainErrorCode returns false for unknown codes', () => {
    expect(isDomainErrorCode('MADE_UP_CODE')).toBe(false);
    expect(isDomainErrorCode('')).toBe(false);
    expect(isDomainErrorCode('unauthorized')).toBe(false); // case-sensitive
  });
});
