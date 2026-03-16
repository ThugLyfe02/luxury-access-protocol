import { DomainError } from '../errors/DomainError';
import { RenterTier } from '../enums/RenterTier';

const TIER_THRESHOLDS: ReadonlyMap<
  RenterTier,
  { minCompletedRentals: number; minAccountAgeDays: number; maxChargebacks: number }
> = new Map([
  [RenterTier.BRONZE, { minCompletedRentals: 0, minAccountAgeDays: 0, maxChargebacks: 2 }],
  [RenterTier.SILVER, { minCompletedRentals: 3, minAccountAgeDays: 30, maxChargebacks: 1 }],
  [RenterTier.GOLD, { minCompletedRentals: 10, minAccountAgeDays: 90, maxChargebacks: 0 }],
  [RenterTier.PLATINUM, { minCompletedRentals: 25, minAccountAgeDays: 180, maxChargebacks: 0 }],
  [RenterTier.BLACK, { minCompletedRentals: 50, minAccountAgeDays: 365, maxChargebacks: 0 }],
]);

const TIER_VALUE_CEILINGS: ReadonlyMap<RenterTier, number> = new Map([
  [RenterTier.BRONZE, 2_000],
  [RenterTier.SILVER, 5_000],
  [RenterTier.GOLD, 15_000],
  [RenterTier.PLATINUM, 50_000],
  [RenterTier.BLACK, Number.POSITIVE_INFINITY],
]);

const TIER_ORDER: ReadonlyArray<RenterTier> = [
  RenterTier.BLACK,
  RenterTier.PLATINUM,
  RenterTier.GOLD,
  RenterTier.SILVER,
  RenterTier.BRONZE,
];

export class TierEngine {
  static computeTier(params: {
    completedRentals: number;
    accountAgeDays: number;
    chargebacksCount: number;
  }): RenterTier {
    for (const tier of TIER_ORDER) {
      const threshold = TIER_THRESHOLDS.get(tier);
      if (!threshold) continue;

      if (
        params.completedRentals >= threshold.minCompletedRentals &&
        params.accountAgeDays >= threshold.minAccountAgeDays &&
        params.chargebacksCount <= threshold.maxChargebacks
      ) {
        return tier;
      }
    }

    return RenterTier.BRONZE;
  }

  static getValueCeiling(tier: RenterTier): number {
    return TIER_VALUE_CEILINGS.get(tier) ?? 0;
  }

  static ensureTierAllowsValue(tier: RenterTier, watchMarketValue: number): void {
    const ceiling = TierEngine.getValueCeiling(tier);
    if (watchMarketValue > ceiling) {
      throw new DomainError(
        `Tier ${tier} has a value ceiling of $${ceiling}; watch value $${watchMarketValue} exceeds it`,
        'TIER_ACCESS_DENIED',
      );
    }
  }
}
