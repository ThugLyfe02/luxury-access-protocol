import { DomainError } from '../errors/DomainError';

const PROCESSING_RATE = 0.029;
const PROCESSING_FIXED = 0.30;
const LOSS_BUFFER_RATE = 0.002;
const MARGIN_FLOOR_MINIMUM = 75;
const MARGIN_FLOOR_RATE = 0.15;

export class UnitEconomicsGuard {
  static assertRentalEconomicsViable(
    rentalCharge: number,
    watchMarketValue: number,
    platformGross: number,
  ): void {
    const breakdown = UnitEconomicsGuard.computeBreakdown(
      rentalCharge,
      watchMarketValue,
      platformGross,
    );

    if (!breakdown.passes) {
      throw new DomainError(
        'Rental economics are negative',
        'ECONOMICS_NEGATIVE',
      );
    }
  }

  static computeBreakdown(
    rentalCharge: number,
    watchMarketValue: number,
    platformGross: number,
  ): {
    processingFees: number;
    lossBuffer: number;
    marginFloor: number;
    netAfterCosts: number;
    passes: boolean;
  } {
    if (
      rentalCharge <= 0 ||
      watchMarketValue <= 0 ||
      platformGross < 0 ||
      !Number.isFinite(rentalCharge) ||
      !Number.isFinite(watchMarketValue) ||
      !Number.isFinite(platformGross)
    ) {
      return {
        processingFees: 0,
        lossBuffer: 0,
        marginFloor: MARGIN_FLOOR_MINIMUM,
        netAfterCosts: 0,
        passes: false,
      };
    }

    const processingFees = rentalCharge * PROCESSING_RATE + PROCESSING_FIXED;
    const lossBuffer = watchMarketValue * LOSS_BUFFER_RATE;
    const marginFloor = Math.max(
      MARGIN_FLOOR_MINIMUM,
      platformGross * MARGIN_FLOOR_RATE,
    );
    const netAfterCosts = platformGross - processingFees - lossBuffer;
    const passes = netAfterCosts >= marginFloor;

    return {
      processingFees,
      lossBuffer,
      marginFloor,
      netAfterCosts,
      passes,
    };
  }
}
