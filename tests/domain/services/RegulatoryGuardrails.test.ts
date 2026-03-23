import { describe, it, expect } from 'vitest';
import { RegulatoryGuardrails } from '../../../src/domain/services/RegulatoryGuardrails';
import { DomainError } from '../../../src/domain/errors/DomainError';

describe('RegulatoryGuardrails', () => {
  describe('assertNoCustodyPrincipalMutation', () => {
    it('allows clean operation names', () => {
      expect(() =>
        RegulatoryGuardrails.assertNoCustodyPrincipalMutation('initiate_rental', { rentalPrice: 500 }),
      ).not.toThrow();
    });

    it('allows clean context values', () => {
      expect(() =>
        RegulatoryGuardrails.assertNoCustodyPrincipalMutation('release_to_owner', {
          rentalId: 'r-1',
          amount: 100,
        }),
      ).not.toThrow();
    });

    // --- HARD STOP: every forbidden keyword must trigger ---
    const forbiddenKeywords = [
      'principal', 'escrow', 'wallet', 'balance', 'transferfunds',
      'credituser', 'debituser', 'heldfunds', 'userfunds',
      'internaltransfer', 'platformbalance', 'payoutqueue', 'releaseatdiscretion',
    ];

    for (const keyword of forbiddenKeywords) {
      it(`blocks operation containing "${keyword}"`, () => {
        expect(() =>
          RegulatoryGuardrails.assertNoCustodyPrincipalMutation(`do_${keyword}_thing`),
        ).toThrow(DomainError);

        try {
          RegulatoryGuardrails.assertNoCustodyPrincipalMutation(`do_${keyword}_thing`);
        } catch (e) {
          expect((e as DomainError).code).toBe('CUSTODY_VIOLATION');
        }
      });

      it(`blocks context containing "${keyword}"`, () => {
        expect(() =>
          RegulatoryGuardrails.assertNoCustodyPrincipalMutation('clean_op', {
            [`${keyword}Amount`]: 100,
          }),
        ).toThrow(DomainError);
      });
    }

    it('keyword detection is case-insensitive', () => {
      expect(() =>
        RegulatoryGuardrails.assertNoCustodyPrincipalMutation('ESCROW_HOLD'),
      ).toThrow(DomainError);

      expect(() =>
        RegulatoryGuardrails.assertNoCustodyPrincipalMutation('PlatformBalance_check'),
      ).toThrow(DomainError);
    });

    it('detects keywords in nested context values', () => {
      expect(() =>
        RegulatoryGuardrails.assertNoCustodyPrincipalMutation('op', {
          nested: { action: 'credituser' },
        }),
      ).toThrow(DomainError);
    });
  });
});
