/**
 * CR-2026-092 — the contribution policy for every service.
 *
 * This replaces the old "map it or leave it unmapped" list. Leaving a service unmapped
 * was a temporary safeguard against guessing; it is no longer acceptable, and every
 * service that can appear on a work order now has a policy.
 *
 * The four codes CR-2026-090 deliberately deferred are resolved here from the actual
 * catalogue rows, the imported price list and historical usage. What that inspection
 * found is recorded against each one, because the reasoning is the part that will
 * matter when somebody revisits the decision.
 */

export type ContributionMode =
  | 'PACKAGE_COMPONENT'
  | 'INCLUDED_IN_BASE'
  | 'ADDITIVE_STANDARD'
  | 'SEPARATE_SLA'
  | 'CONDITIONAL'
  | 'CUSTOM_ONLY';

export type DurationSource =
  | 'MANAGER_PACKAGE'
  | 'SERVICE_CATALOG_DURATION'
  | 'FIXED_CONFIGURED_DURATION'
  | 'NO_DURATION';

export type AllowanceBasis = 'PER_JOB' | 'PER_SERVICE_LINE' | 'PER_UNIT';
export type RequiredQualifier = 'NONE' | 'BRAKE' | 'TIRE_OPERATION';
export type ComponentRole =
  | 'GENERAL_SERVICE_CORE'
  | 'FRONT_BRAKES'
  | 'SPARK_PLUGS'
  | 'INCLUDED_NO_ADDITIONAL_BENCHMARK'
  | 'FORCES_CUSTOM_BENCHMARK';

export interface ContributionSeed {
  serviceCode: string;
  contributionMode: ContributionMode;
  componentRole?: ComponentRole;
  durationSource: DurationSource;
  allowanceBasis?: AllowanceBasis;
  requiredQualifier?: RequiredQualifier;
  fixedSedanMinutes?: number;
  fixedSuvMinutes?: number;
  requiresAxleQualifier?: boolean;
  /**
   * A stand-in seeded because the catalogue had no usable duration. Surfaced as a
   * warning so it is replaced deliberately rather than hardening into an accepted
   * standard by default.
   */
  provisionalDuration?: boolean;
  notes: string;
}

/**
 * The minutes to seed when a service needs a provisional allowance because its
 * catalogue duration is missing, zero or otherwise unusable.
 */
export const PROVISIONAL_ADDITIVE_MINUTES = 30;

export const KPI_CONTRIBUTION_SEED: ContributionSeed[] = [
  // =========================================================================
  // Package components
  // =========================================================================
  {
    serviceCode: 'OIL-01',
    contributionMode: 'PACKAGE_COMPONENT',
    componentRole: 'GENERAL_SERVICE_CORE',
    durationSource: 'MANAGER_PACKAGE',
    notes:
      'Anchors the General Service component. A manager package is only detected when ' +
      'this is present — brake or plug work alone is measured on catalogue times, not ' +
      'given a general-service allowance nobody asked for.',
  },
  {
    serviceCode: 'SPK-01',
    contributionMode: 'PACKAGE_COMPONENT',
    componentRole: 'SPARK_PLUGS',
    durationSource: 'MANAGER_PACKAGE',
    notes: 'Anchors the Spark Plugs component (catalogue duration 120 min when standalone).',
  },

  // =========================================================================
  // FUEL-FLT-01 — "Fuel Filter Change", family Service, 30 min
  // =========================================================================
  //
  // Catalogue inspection: a valid 30-minute duration, so no provisional allowance is
  // needed. It is a distinct service from OIL-FLT-01 "Oil Filter Change" (20 min),
  // which IS the ordinary filter absorbed by an oil change.
  //
  // Noted for management, not acted on: the imported price list carries "Engine
  // Tuneup - Engine Oil, Oil Filter, Ac Filter, Air Filter; Fuel Filter" as a single
  // FULL SERVICE line, so the shop's own full-service package does include a fuel
  // filter. That package is a larger thing than the manager's 90-minute General
  // Service, whose activity list says only "filters". Per the directive this is
  // ADDITIVE_STANDARD; if management later decides the general service already covers
  // it, the admin screen changes it with an effective date and no code change.
  {
    serviceCode: 'FUEL-FLT-01',
    contributionMode: 'ADDITIVE_STANDARD',
    durationSource: 'SERVICE_CATALOG_DURATION',
    allowanceBasis: 'PER_JOB',
    notes:
      'Genuine additional technician work. Adds its 30-minute catalogue duration once ' +
      'to a General Service package; used as the job standard when performed alone. ' +
      'Distinct from OIL-FLT-01, which is the ordinary filter already inside a service.',
  },

  // =========================================================================
  // BRK-01 / BRK-02 / DISC-01 — brakes, all conditional
  // =========================================================================
  //
  // "Brake work" says nothing useful on its own. The imported price list proves the
  // shop already distinguishes: separate lines for "To R/R DISC PADS", "To R/R DISC
  // PADS rear electronic", "R/R BRAKE SHOE" (drums), "BRAKE FLUID FLUSH", "To R/R Disc
  // Rotors" and "To Clean & Adjust Brakes". Front pads, rear shoes and a fluid bleed
  // are different jobs with different allowances, so every brake code needs an axle
  // AND a work type before it can be resolved.
  {
    serviceCode: 'BRK-01',
    contributionMode: 'CONDITIONAL',
    componentRole: 'FRONT_BRAKES',
    durationSource: 'SERVICE_CATALOG_DURATION',
    requiredQualifier: 'BRAKE',
    requiresAxleQualifier: true,
    notes:
      '"Brake Inspection", 30 min. Inspection inside a General Service adds nothing; ' +
      'booked alone it uses its 30-minute catalogue standard. If the line is qualified ' +
      'as actual pad or shoe work it resolves like any other brake line.',
  },
  {
    serviceCode: 'BRK-02',
    contributionMode: 'CONDITIONAL',
    componentRole: 'FRONT_BRAKES',
    durationSource: 'SERVICE_CATALOG_DURATION',
    requiredQualifier: 'BRAKE',
    requiresAxleQualifier: true,
    notes:
      '"Brake Pad Replacement", 90 min. The code actually used on work orders. Front ' +
      'pads with a General Service satisfy the Front Brakes package component and add ' +
      'NO extra minutes — the package already contains that allowance. Anything else ' +
      '(rear, shoes, rotors, fluid) is additive on the catalogue time.',
  },
  {
    serviceCode: 'DISC-01',
    contributionMode: 'CONDITIONAL',
    componentRole: 'FRONT_BRAKES',
    durationSource: 'SERVICE_CATALOG_DURATION',
    requiredQualifier: 'BRAKE',
    requiresAxleQualifier: true,
    notes:
      '"Disc Pad Change", 60 min. An alias of BRK-02 for the same Front Brakes ' +
      'component — never used on a work order in the whole history, so it is marked ' +
      'superseded to keep it out of new bookings while historical lines stay intact. ' +
      'Two aliases on one order still fit one set of pads and count once.',
  },

  // =========================================================================
  // EST-01 — "Estimate / Inspection", family Service, 30 min
  // =========================================================================
  //
  // Repository inspection settles this as TECHNICIAN work rather than quotation
  // preparation, so the directive's diagnostic-assessment case applies:
  //
  //  - it requires a bay (requiredBayType GENERAL) and carries mobileJackAllowed —
  //    an administrative quote needs neither a ramp nor a jack;
  //  - it carries a technician skill code (GENERAL), which is what the scheduling
  //    engine matches technicians on;
  //  - it has a real 30-minute duration and is bookable as a work-order line, and
  //    every ServiceType on an order draws a technician and a bay;
  //  - the platform's actual quoting path is elsewhere — inspection recommendations
  //    with customer decisions (CR-2026-034) — and does not use a ServiceType;
  //  - the imported price list contains no estimate or quotation line at all.
  //
  // SEPARATE_SLA remains available and tested for genuine advisor activity; no
  // catalogue service currently qualifies.
  {
    serviceCode: 'EST-01',
    contributionMode: 'ADDITIVE_STANDARD',
    durationSource: 'SERVICE_CATALOG_DURATION',
    allowanceBasis: 'PER_JOB',
    notes:
      'Technician-performed assessment, not quotation preparation: it needs a bay, a ' +
      'jack and a technician skill, and the advisor quoting flow uses inspection ' +
      'recommendations instead. Adds its 30-minute catalogue duration.',
  },

  // =========================================================================
  // TIR-01 — "Tire Rotation", family Quick Service, 25 min
  // =========================================================================
  //
  // The catalogue name is Rotation, and the price list carries "Rotate Tyres" as its
  // own billable line, so this is real chargeable work rather than a courtesy check.
  // It is CONDITIONAL because the same code is used for the pressure/tread check that
  // the manager's General Service activity list already includes, and those two must
  // not share an allowance.
  {
    serviceCode: 'TIR-01',
    contributionMode: 'CONDITIONAL',
    durationSource: 'SERVICE_CATALOG_DURATION',
    requiredQualifier: 'TIRE_OPERATION',
    allowanceBasis: 'PER_JOB',
    notes:
      '"Tire Rotation", 25 min. A pressure or tread check inside a General Service adds ' +
      'nothing (the activity list already includes it); rotation, balance, alignment, ' +
      'puncture repair and replacement are additive on the 25-minute catalogue time. ' +
      'PER_JOB — a four-wheel rotation is one operation, not four.',
  },

  // =========================================================================
  // Absorbed by the General Service standard
  // =========================================================================
  // Only activities the manager's own breakdown names: "oil change, filters, wipers,
  // fluid checks, paperwork".
  {
    serviceCode: 'OIL-FLT-01',
    contributionMode: 'INCLUDED_IN_BASE',
    durationSource: 'NO_DURATION',
    notes: 'An oil change includes the filter; a separate line is bookkeeping, not extra work.',
  },
  {
    serviceCode: 'AIR-FLT-01',
    contributionMode: 'INCLUDED_IN_BASE',
    durationSource: 'NO_DURATION',
    notes: 'Named under "filters" in the general-service activity breakdown.',
  },
  {
    serviceCode: 'WIPER-01',
    contributionMode: 'INCLUDED_IN_BASE',
    durationSource: 'NO_DURATION',
    notes: 'Named as "wipers" in the general-service activity breakdown.',
  },

  // =========================================================================
  // Additive technician work
  // =========================================================================
  // Everything here is real work with a real catalogue duration. Under the old model
  // these forced the whole job out of its benchmark; now they extend the standard,
  // which is what "the technician did more, so allow more time" should always have
  // meant.
  ...(
    [
      ['BAT-01', 'Battery test / replace.'],
      ['BEL-01', 'Belt / hose replacement.'],
      ['BELT-01', 'Belt replacement.'],
      ['BJOINT-01', 'Ball joint replacement.'],
      ['BULB-01', 'Bulb replacement.'],
      ['COL-01', 'Cooling system service.'],
      ['ELE-01', 'Electrical diagnostic.'],
      ['ENG-01', 'Engine diagnostic.'],
      ['ENG-02', 'Major tune-up.'],
      ['GEN-01', 'General diagnostic.'],
      ['INSP-01', 'Pre-purchase inspection.'],
      ['RACK-01', 'Rack and pinion.'],
      ['SHOCK-01', 'Shocks replacement.'],
      ['SUSP-01', 'Suspension inspection.'],
      ['SUSP-02', 'Shock / strut replacement.'],
      ['TIR-02', 'Wheel alignment.'],
      ['TIR-03', 'Tyre install and balance.'],
      ['TRANS-01', 'Transmission diagnostic.'],
      ['AC-01', 'A/C diagnostic.'],
      ['AC-02', 'A/C repair.'],
      ['CLEAN-01', 'Vehicle cleaning.'],
    ] as const
  ).map(
    ([serviceCode, what]): ContributionSeed => ({
      serviceCode,
      contributionMode: 'ADDITIVE_STANDARD',
      durationSource: 'SERVICE_CATALOG_DURATION',
      allowanceBasis: 'PER_JOB',
      notes: `${what} Additive on its catalogue duration.`,
    }),
  ),

  // =========================================================================
  // Genuinely bespoke
  // =========================================================================
  {
    serviceCode: 'MSHOP-01',
    contributionMode: 'CUSTOM_ONLY',
    durationSource: 'NO_DURATION',
    notes:
      'External machine-shop work. Elapsed time is outside the technician’s control and ' +
      'varies with a third party, so no catalogue standard can describe it. The one ' +
      'service where CUSTOM_ONLY is the honest answer rather than a shrug.',
  },
];
