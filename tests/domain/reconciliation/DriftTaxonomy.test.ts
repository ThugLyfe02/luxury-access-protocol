import { describe, it, expect } from 'vitest';
import { DriftTaxonomy } from '../../../src/domain/services/DriftTaxonomy';
import { DriftType } from '../../../src/domain/enums/DriftType';
import { ReconciliationSeverity } from '../../../src/domain/enums/ReconciliationSeverity';

describe('DriftTaxonomy', () => {
  it('classifies every DriftType', () => {
    for (const driftType of Object.values(DriftType)) {
      const classification = DriftTaxonomy.classify(driftType);
      expect(classification).toBeDefined();
      expect(classification.severity).toBeDefined();
      expect(classification.recommendedAction).toBeDefined();
      expect(typeof classification.autoRepairAllowed).toBe('boolean');
      expect(typeof classification.freezeRequired).toBe('boolean');
      expect(typeof classification.reviewRequired).toBe('boolean');
      expect(classification.description.length).toBeGreaterThan(0);
    }
  });

  it('throws for unknown drift type', () => {
    expect(() => DriftTaxonomy.classify('UNKNOWN' as DriftType)).toThrow('Unknown drift type');
  });

  // Auto-repair only allowed for exactly 2 drift types
  it('only allows auto-repair for PROVIDER_CAPTURED and PROVIDER_DISPUTE', () => {
    const autoRepairTypes = Object.values(DriftType).filter(
      dt => DriftTaxonomy.classify(dt).autoRepairAllowed,
    );
    expect(autoRepairTypes).toHaveLength(2);
    expect(autoRepairTypes).toContain(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED);
    expect(autoRepairTypes).toContain(DriftType.PROVIDER_DISPUTE_OPEN_BUT_INTERNAL_CLEAN);
  });

  // CRITICAL drifts require freeze
  it('requires freeze for CRITICAL severity drifts', () => {
    const criticalTypes = Object.values(DriftType).filter(
      dt => DriftTaxonomy.classify(dt).severity === ReconciliationSeverity.CRITICAL,
    );
    expect(criticalTypes.length).toBeGreaterThan(0);
    for (const dt of criticalTypes) {
      expect(DriftTaxonomy.classify(dt).freezeRequired).toBe(true);
    }
  });

  // Specific severity assertions
  it('classifies INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING as CRITICAL', () => {
    expect(DriftTaxonomy.classify(DriftType.INTERNAL_AUTHORIZED_BUT_PROVIDER_MISSING).severity)
      .toBe(ReconciliationSeverity.CRITICAL);
  });

  it('classifies PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED as HIGH', () => {
    expect(DriftTaxonomy.classify(DriftType.PROVIDER_CAPTURED_BUT_INTERNAL_NOT_CAPTURED).severity)
      .toBe(ReconciliationSeverity.HIGH);
  });

  it('classifies CONNECTED_ACCOUNT_STATE_MISMATCH as LOW', () => {
    expect(DriftTaxonomy.classify(DriftType.CONNECTED_ACCOUNT_STATE_MISMATCH).severity)
      .toBe(ReconciliationSeverity.LOW);
  });

  it('allClassifications returns the full map', () => {
    const all = DriftTaxonomy.allClassifications();
    expect(all.size).toBe(Object.values(DriftType).length);
  });
});
