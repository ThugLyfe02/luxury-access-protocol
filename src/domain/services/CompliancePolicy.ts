import { DomainError } from '../errors/DomainError';
import { ACTIVE_CITIES } from '../enums/City';

const NYC_ZIP_PREFIX_MIN = 100;
const NYC_ZIP_PREFIX_MAX = 114;

export class CompliancePolicy {
  static ensureCityActive(city: string): void {
    const normalized = city.trim().toUpperCase();
    if (!ACTIVE_CITIES.has(normalized)) {
      throw new DomainError('City is not active', 'CITY_NOT_ACTIVE');
    }
  }

  static ensureZipMatchesCity(zipCode: string, city: string): void {
    const normalizedCity = city.trim().toUpperCase();

    if (normalizedCity !== 'NYC') {
      return;
    }

    const trimmed = zipCode.trim();

    if (trimmed.length < 5) {
      throw new DomainError(
        'Invalid ZIP code for NYC',
        'CITY_NOT_ACTIVE',
      );
    }

    const prefix = parseInt(trimmed.substring(0, 3), 10);

    if (isNaN(prefix)) {
      throw new DomainError(
        'Invalid ZIP code format',
        'CITY_NOT_ACTIVE',
      );
    }

    if (prefix < NYC_ZIP_PREFIX_MIN || prefix > NYC_ZIP_PREFIX_MAX) {
      throw new DomainError(
        'ZIP code is outside NYC service area',
        'CITY_NOT_ACTIVE',
      );
    }
  }
}
