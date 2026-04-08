/**
 * Vehicle Identity Provider Interface
 *
 * Abstraction for VIN decoding services. The platform ships with a stub
 * provider that returns ESTIMATE-confidence data derived from the existing
 * Vehicle record. Real providers (e.g. NHTSA vPIC, CarMD, etc.) can be
 * swapped in via the DI token without touching business logic.
 */
export interface VehicleDecodeResult {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  engineCode: string | null;
  engineDescription: string | null;
  displacement: string | null;
  fuelType: string | null;
  driveType: string | null;
  decodeSource: string;
  confidence: 'OEM' | 'VERIFIED' | 'NEEDS_CONFIRMATION' | 'ESTIMATE';
}

export interface VehicleIdentityProvider {
  decodeVin(vin: string): Promise<VehicleDecodeResult | null>;
}

export const VEHICLE_IDENTITY_PROVIDER = 'VEHICLE_IDENTITY_PROVIDER';
