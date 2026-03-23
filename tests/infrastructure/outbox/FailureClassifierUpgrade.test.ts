import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../../src/infrastructure/outbox/FailureClassifier';
import { ProviderError } from '../../../src/domain/errors/ProviderError';
import { DomainError } from '../../../src/domain/errors/DomainError';

describe('FailureClassifier with ProviderError support', () => {
  describe('ambiguous classification', () => {
    it('classifies ambiguous ProviderError as ambiguous', () => {
      const error = new ProviderError({
        message: 'capturePayment: Connection timed out',
        code: 'PROVIDER_NETWORK_TIMEOUT',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('ambiguous');
      expect(result.message).toContain('AMBIGUOUS:');
    });

    it('non-state-changing timeout is retryable, not ambiguous', () => {
      const error = new ProviderError({
        message: 'fetchSnapshot: Connection timed out',
        code: 'PROVIDER_NETWORK_TIMEOUT',
        isStateChanging: false,
      });
      // PROVIDER_NETWORK_TIMEOUT is retryable but only ambiguous when state-changing
      const result = classifyFailure(error);
      expect(result.kind).toBe('retryable');
      expect(result.message).not.toContain('AMBIGUOUS:');
    });
  });

  describe('retryable provider errors', () => {
    it('classifies PROVIDER_RATE_LIMITED as retryable', () => {
      const error = new ProviderError({
        message: 'Too many requests',
        code: 'PROVIDER_RATE_LIMITED',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('retryable');
    });

    it('classifies PROVIDER_UNAVAILABLE as retryable', () => {
      const error = new ProviderError({
        message: 'Service unavailable',
        code: 'PROVIDER_UNAVAILABLE',
        isStateChanging: false,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('retryable');
    });

    it('classifies PROVIDER_UNKNOWN as retryable', () => {
      const error = new ProviderError({
        message: 'Something unexpected',
        code: 'PROVIDER_UNKNOWN',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('retryable');
    });
  });

  describe('permanent provider errors', () => {
    it('classifies PROVIDER_CARD_DECLINED as permanent', () => {
      const error = new ProviderError({
        message: 'Card declined',
        code: 'PROVIDER_CARD_DECLINED',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies PROVIDER_INVALID_REQUEST as permanent', () => {
      const error = new ProviderError({
        message: 'Invalid amount',
        code: 'PROVIDER_INVALID_REQUEST',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies PROVIDER_AUTHENTICATION_FAILED as permanent', () => {
      const error = new ProviderError({
        message: 'Bad API key',
        code: 'PROVIDER_AUTHENTICATION_FAILED',
        isStateChanging: false,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies PROVIDER_RESOURCE_NOT_FOUND as permanent', () => {
      const error = new ProviderError({
        message: 'No such payment intent',
        code: 'PROVIDER_RESOURCE_NOT_FOUND',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('classifies PROVIDER_IDEMPOTENCY_CONFLICT as permanent', () => {
      const error = new ProviderError({
        message: 'Idempotency key conflict',
        code: 'PROVIDER_IDEMPOTENCY_CONFLICT',
        isStateChanging: true,
      });
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });
  });

  describe('backward compatibility', () => {
    it('still classifies DomainError with INVALID_STATE_TRANSITION as permanent', () => {
      const error = new DomainError('Invalid transition', 'INVALID_STATE_TRANSITION');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('still classifies DomainError with VERSION_CONFLICT as permanent', () => {
      const error = new DomainError('Conflict', 'VERSION_CONFLICT');
      const result = classifyFailure(error);
      expect(result.kind).toBe('permanent');
    });

    it('still classifies plain Error as retryable', () => {
      const result = classifyFailure(new Error('Some random error'));
      expect(result.kind).toBe('retryable');
    });

    it('still classifies card_declined message pattern as permanent', () => {
      const result = classifyFailure(new Error('card_declined'));
      expect(result.kind).toBe('permanent');
    });

    it('still classifies non-Error values as retryable', () => {
      const result = classifyFailure('string error');
      expect(result.kind).toBe('retryable');
    });
  });
});
