import { Injectable, Logger } from '@nestjs/common';
import {
  FluidSpecProvider,
  FluidSpecResult,
} from './fluid-spec.provider.interface';

/**
 * Default interval defaults used when no BusinessRuleConfig override exists.
 * These are conservative baseline values only.
 */
const DEFAULT_NORMAL_INTERVAL_MILES = 5000;
const DEFAULT_SEVERE_INTERVAL_MILES = 3000;
const DEFAULT_NORMAL_INTERVAL_MONTHS = 6;
const DEFAULT_SEVERE_INTERVAL_MONTHS = 3;

/**
 * Stub Fluid Specification Provider
 *
 * CRITICAL BUSINESS RULE: This provider NEVER returns a specific oil grade,
 * viscosity, API category, ILSAC category, OEM approval code, or capacity.
 * Those fields are always null. Only interval data is returned with ESTIMATE
 * confidence.
 *
 * Rationale: Recommending the wrong oil specification can cause engine damage.
 * Without engine-specific data from a verified source, the system must not
 * suggest any particular fluid. The front desk / service advisor is expected
 * to confirm fluid specs manually or wait for a real provider integration.
 */
@Injectable()
export class StubFluidSpecProvider implements FluidSpecProvider {
  private readonly logger = new Logger(StubFluidSpecProvider.name);

  async getFluidSpec(input: {
    engineCode?: string;
    year: number;
    make: string;
    model: string;
    serviceTypeCode: string;
  }): Promise<FluidSpecResult | null> {
    this.logger.debug(
      `Stub fluid spec lookup for ${input.year} ${input.make} ${input.model} ` +
        `[${input.serviceTypeCode}] — returning intervals only, no fluid grades`,
    );

    // NEVER return specific oil grades — only intervals with ESTIMATE confidence.
    return {
      saeViscosityGrade: null,
      apiCategory: null,
      ilsacCategory: null,
      oemApprovalCode: null,
      capacityWithFilter: null,
      capacityWithoutFilter: null,
      normalIntervalMiles: DEFAULT_NORMAL_INTERVAL_MILES,
      severeIntervalMiles: DEFAULT_SEVERE_INTERVAL_MILES,
      normalIntervalMonths: DEFAULT_NORMAL_INTERVAL_MONTHS,
      severeIntervalMonths: DEFAULT_SEVERE_INTERVAL_MONTHS,
      sourceProvider: 'STUB_DEFAULT',
      confidence: 'ESTIMATE',
      intervalsAreDifferentiated: false,
    };
  }
}
