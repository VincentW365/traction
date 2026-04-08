import { Injectable, Logger } from '@nestjs/common';
import {
  VehicleIdentityProvider,
  VehicleDecodeResult,
} from './vehicle-identity.provider.interface';

/**
 * Stub VIN decoder that returns ESTIMATE-confidence data.
 *
 * This provider does NOT call any external API. It exists so the platform
 * can operate without a paid VIN-decode subscription. When a real provider
 * is configured it should be bound to the VEHICLE_IDENTITY_PROVIDER token
 * in the module definition.
 *
 * IMPORTANT: trim, engineCode, displacement, fuelType, driveType are always
 * null because they cannot be reliably inferred without an external source.
 */
@Injectable()
export class StubVehicleIdentityProvider implements VehicleIdentityProvider {
  private readonly logger = new Logger(StubVehicleIdentityProvider.name);

  async decodeVin(vin: string): Promise<VehicleDecodeResult | null> {
    if (!vin || vin.trim().length === 0) {
      return null;
    }

    this.logger.debug(
      `Stub VIN decode for ${vin} — returning ESTIMATE confidence`,
    );

    // We cannot derive any vehicle specifics from VIN without a real decoder.
    // Return a shell result so callers know a decode was attempted.
    return {
      year: null,
      make: null,
      model: null,
      trim: null,
      engineCode: null,
      engineDescription: null,
      displacement: null,
      fuelType: null,
      driveType: null,
      decodeSource: 'STUB',
      confidence: 'ESTIMATE',
    };
  }
}
