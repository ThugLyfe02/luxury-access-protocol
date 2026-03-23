import { DomainError } from '../errors/DomainError';
import { ACTIVE_CITIES } from '../enums/City';

const NYC_ZIP_PREFIX_MIN = 100;
const NYC_ZIP_PREFIX_MAX = 114;
const ZIP_PATTERN = /^\d{5}$/;

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

    if (!ZIP_PATTERN.test(trimmed)) {
      throw new DomainError(
        'ZIP code must be exactly 5 numeric digits',
        'CITY_NOT_ACTIVE',
      );
    }

    const prefix = parseInt(trimmed.substring(0, 3), 10);

    if (prefix < NYC_ZIP_PREFIX_MIN || prefix > NYC_ZIP_PREFIX_MAX) {
      throw new DomainError(
        'ZIP code is outside NYC service area',
        'CITY_NOT_ACTIVE',
      );
    }
  }
}
