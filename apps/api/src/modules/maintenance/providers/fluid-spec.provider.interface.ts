/**
 * Fluid Specification Provider Interface
 *
 * Abstraction for fluid/interval lookup services. The stub provider returns
 * only generic intervals with null oil-grade fields and ESTIMATE confidence.
 * A real provider (e.g. LubricationSpecialties, Motor API) can be injected
 * via the DI token to return OEM-verified fluid specifications.
 */
export interface FluidSpecResult {
  saeViscosityGrade: string | null;
  apiCategory: string | null;
  ilsacCategory: string | null;
  oemApprovalCode: string | null;
  capacityWithFilter: number | null;
  capacityWithoutFilter: number | null;
  normalIntervalMiles: number | null;
  severeIntervalMiles: number | null;
  normalIntervalMonths: number | null;
  severeIntervalMonths: number | null;
  sourceProvider: string;
  confidence: 'OEM' | 'VERIFIED' | 'NEEDS_CONFIRMATION' | 'ESTIMATE';
  intervalsAreDifferentiated: boolean;
}

export interface FluidSpecProvider {
  getFluidSpec(input: {
    engineCode?: string;
    year: number;
    make: string;
    model: string;
    serviceTypeCode: string;
  }): Promise<FluidSpecResult | null>;
}

export const FLUID_SPEC_PROVIDER = 'FLUID_SPEC_PROVIDER';
