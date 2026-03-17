import { describe, it, expect } from 'vitest';
import { classifyError, FailureCategory } from '../../../src/infrastructure/resilience/FailureClassification';
import { DomainError } from '../../../src/domain/errors/DomainError';

describe('FailureClassification', () => {
  describe('classifyError', () => {
    it('classifies non-Error as INTERNAL_UNEXPECTED', () => {
      const result = classifyError('string error');
      expect(result.category).toBe(FailureCategory.INTERNAL_UNEXPECTED);
      expect(result.retryable).toBe(false);
      expect(result.httpStatus).toBe(500);
    });

    it('classifies DomainError with client validation code', () => {
      const err = new DomainError('Bad name', 'INVALID_NAME');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.CLIENT_VALIDATION);
      expect(result.retryable).toBe(false);
      expect(result.httpStatus).toBe(400);
      expect(result.logLevel).toBe('warn');
      expect(result.alertSeverity).toBe('none');
    });

    it('classifies DomainError with auth code', () => {
      const err = new DomainError('Unauthorized', 'UNAUTHORIZED');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.AUTH);
      expect(result.retryable).toBe(false);
      expect(result.httpStatus).toBe(401);
    });

    it('classifies DomainError with domain hard-stop code', () => {
      const err = new DomainError('Invalid transition', 'INVALID_STATE_TRANSITION');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.DOMAIN_HARD_STOP);
      expect(result.retryable).toBe(false);
      expect(result.httpStatus).toBe(409);
    });

    it('classifies timeout errors', () => {
      const err = new Error('Operation timed out after 10000ms');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.TIMEOUT);
      expect(result.retryable).toBe(true);
      expect(result.circuitBreakerCountable).toBe(true);
      expect(result.httpStatus).toBe(504);
    });

    it('classifies network errors as transient', () => {
      const err = new Error('ECONNREFUSED');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.DEPENDENCY_TRANSIENT);
      expect(result.retryable).toBe(true);
      expect(result.circuitBreakerCountable).toBe(true);
    });

    it('classifies ECONNRESET as transient', () => {
      const err = new Error('socket hang up');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.DEPENDENCY_TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it('classifies PAYMENT_PROVIDER_UNAVAILABLE as transient', () => {
      const err = new DomainError('Provider down', 'PAYMENT_PROVIDER_UNAVAILABLE');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.DEPENDENCY_TRANSIENT);
      expect(result.retryable).toBe(true);
    });

    it('classifies unknown errors as INTERNAL_UNEXPECTED', () => {
      const err = new Error('something weird happened');
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.INTERNAL_UNEXPECTED);
      expect(result.retryable).toBe(false);
      expect(result.alertSeverity).toBe('high');
    });

    it('classifies ETIMEDOUT by code', () => {
      const err = new Error('connect failed');
      (err as any).code = 'ETIMEDOUT';
      const result = classifyError(err);
      expect(result.category).toBe(FailureCategory.TIMEOUT);
    });

    it('preserves original error reference', () => {
      const err = new Error('test');
      (err as any).code = 'INVALID_OWNER';
      const result = classifyError(err);
      expect(result.originalError).toBe(err);
    });
  });
});
