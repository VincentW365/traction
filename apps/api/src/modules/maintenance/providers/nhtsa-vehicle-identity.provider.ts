import { Injectable, Logger } from '@nestjs/common';
import {
  VehicleIdentityProvider,
  VehicleDecodeResult,
} from './vehicle-identity.provider.interface';

const NHTSA_BASE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const TIMEOUT_MS = 5000;

/**
 * NHTSA vPIC VIN Decode Provider.
 *
 * Calls the free US government API to decode vehicle identification numbers.
 * Falls back gracefully on timeout, network error, or empty results.
 * Supports model year hint for improved accuracy.
 */
@Injectable()
export class NhtsaVehicleIdentityProvider implements VehicleIdentityProvider {
  private readonly logger = new Logger(NhtsaVehicleIdentityProvider.name);

  async decodeVin(vin: string, modelYear?: number): Promise<VehicleDecodeResult | null> {
    if (!vin || vin.trim().length < 11) {
      this.logger.debug(`VIN too short for NHTSA decode: "${vin}"`);
      return null;
    }

    const yearParam = modelYear ? `&modelyear=${modelYear}` : '';
    const url = `${NHTSA_BASE_URL}/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json${yearParam}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn(`NHTSA returned HTTP ${response.status} for VIN ${vin}`);
        return null;
      }

      const json = await response.json() as { Results?: Record<string, string>[] };
      const results = json?.Results;
      if (!results || !Array.isArray(results) || results.length === 0) {
        this.logger.warn(`NHTSA returned empty results for VIN ${vin}`);
        return null;
      }

      const r = results[0];

      // NHTSA returns ErrorCode "0" for successful decode
      const errorCode = String(r.ErrorCode ?? '').trim();
      const hasErrors = errorCode !== '0' && errorCode !== '';

      const year = r.ModelYear ? parseInt(r.ModelYear, 10) : null;
      const make = r.Make || null;
      const model = r.Model || null;
      const trim = r.Trim || null;
      const engineCode = r.EngineModel || null;
      const engineDescription = [r.EngineModel, r.DisplacementL ? `${r.DisplacementL}L` : null]
        .filter(Boolean)
        .join(' ') || null;
      const displacement = r.DisplacementL ? `${r.DisplacementL}L` : null;
      const fuelType = r.FuelTypePrimary || null;
      const driveType = r.DriveType || null;

      // Determine confidence
      const coreFieldsPresent = !!(year && make && model);
      let confidence: VehicleDecodeResult['confidence'];
      if (hasErrors || !coreFieldsPresent) {
        confidence = 'NEEDS_CONFIRMATION';
      } else if (engineCode && trim) {
        confidence = 'VERIFIED';
      } else {
        confidence = 'VERIFIED';
      }

      this.logger.log(
        `NHTSA decode for ${vin}: ${year} ${make} ${model} — confidence=${confidence}`,
      );

      return {
        year,
        make,
        model,
        trim,
        engineCode,
        engineDescription,
        displacement,
        fuelType,
        driveType,
        decodeSource: 'NHTSA',
        confidence,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.logger.warn(`NHTSA decode timed out after ${TIMEOUT_MS}ms for VIN ${vin}`);
      } else {
        this.logger.warn(`NHTSA decode failed for VIN ${vin}: ${err.message}`);
      }
      return null;
    }
  }
}
