import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../../src/infrastructure/outbox/FailureClassifier';
import { DomainError } from '../../../src/domain/errors/DomainError';

describe('FailureClassifier', () => {
  describe('retryable failures', () => {
    it('classifies network errors as retryable', () => {
      const result = classifyFailure(new Error('ECONNREFUSED'));
      expect(result.kind).toBe('retryable');
    });

    it('classifies timeout errors as retryable', () => {
      const result = classifyFailure(new Error('Request timeout'));
      expect(result.kind).toBe('retryable');
    });

    it('classifies unknown errors as retryable', () => {
      const result = classifyFailure(new Error('Something unexpected'));
      expect(result.kind).toBe('retryable');
    });

    it('classifies non-Error values as retryable', () => {
      const result = classifyFailure('string error');
      expect(result.kind).toBe('retryable');
      expect(result.message).toBe('string error');
    });
  });

  describe('permanent failures', () => {
    it('classifies INVALID_STATE_TRANSITION as permanent', () => {
      const error = new DomainError('Invalid transition', 'INVALID_STATE_TRANSITION');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies DUPLICATE_REQUEST as permanent', () => {
      const error = new DomainError('Duplicate', 'DUPLICATE_REQUEST');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies VERSION_CONFLICT as permanent', () => {
      const error = new DomainError('Conflict', 'VERSION_CONFLICT');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies card_declined message as permanent', () => {
      const error = new Error('Payment failed: card_declined');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies expired_card message as permanent', () => {
      const error = new Error('Error: expired_card');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies charge_already_captured as permanent', () => {
      const error = new Error('Stripe error: charge_already_captured');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies CONNECTED_ACCOUNT_MISSING as permanent', () => {
      const error = new DomainError('No account', 'CONNECTED_ACCOUNT_MISSING');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies RELEASE_NOT_ALLOWED as permanent', () => {
      const error = new DomainError('Already released', 'RELEASE_NOT_ALLOWED');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });
  });
});
