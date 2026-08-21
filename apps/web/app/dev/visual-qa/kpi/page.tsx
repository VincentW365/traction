/**
 * Visual-QA harness for the KPI strip and the KPI calculation panel.
 *
 * Every state these two components can reach, on one page, so a reviewer can compare
 * them side by side and a screenshot run produces stable evidence. States that only
 * occur against particular real jobs (a shared job, a missing qualifier, a provisional
 * duration) are otherwise reachable only by contriving database rows.
 *
 * DOUBLE-GATED AND OFF BY DEFAULT. It is not a production surface, so it must not exist
 * in a production build, and it must not appear on a local or staging machine that did
 * not explicitly ask for it — a route nobody remembers enabling is a route nobody
 * remembers to disable.
 *
 * SYNTHETIC DATA ONLY. No API client, no fetch, no react-query: a QA harness that reads
 * live data captures whatever happened to be in the database that morning, which is
 * neither reproducible nor safe to circulate. Every name, plate and ticket below is
 * obviously fake for the same reason — screenshots get pasted into tickets and chats.
 */

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { KpiStrip, type LiveKpi, type KpiRating } from '../../../../components/kpi-strip';
import {
  KpiCalculationPanel,
  type KpiCalculationBreakdown,
} from '../../../../components/kpi-calculation-panel';
import { EmptyState } from '../../../../components/ui/empty-state';
import { LoadingState } from '../../../../components/ui/loading-state';

/** The gate reads the environment per request, so it must never be prerendered. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Visual QA — KPI',
  robots: { index: false, follow: false },
};

function visualQaEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ENABLE_VISUAL_QA === 'true';
}

/* ---------------------------------- fixtures ---------------------------------- */

const BASE_KPI: LiveKpi = {
  vehicleClass: 'SEDAN_CLASS',
  packageType: 'GENERAL_SERVICE_ONLY',
  packageReason: null,
  standardMinutes: 90,
  minutesRemaining: null,
  kpiCompletionMinutes: null,
  rawElapsedMinutes: null,
  approvedExcludedMinutes: 0,
  varianceMinutes: null,
  adjustedTechnicianRating: null,
  absoluteCompletionRating: null,
  inFlight: false,
};

/**
 * Derives the figures the strip reads from each other so a fixture cannot quietly
 * contradict itself — a screenshot showing "90 standard, 200 elapsed, 30 remaining"
 * would be read as a rendering bug rather than a bad fixture.
 */
function kpi(over: {
  standardMinutes: number;
  elapsed: number;
  rating: KpiRating;
  vehicleClass?: string | null;
  packageType?: string;
  inFlight?: boolean;
  approvedExcludedMinutes?: number;
}): LiveKpi {
  const variance = over.elapsed - over.standardMinutes;
  return {
    ...BASE_KPI,
    vehicleClass: over.vehicleClass === undefined ? 'SEDAN_CLASS' : over.vehicleClass,
    packageType: over.packageType ?? 'GENERAL_SERVICE_ONLY',
    standardMinutes: over.standardMinutes,
    kpiCompletionMinutes: over.elapsed,
    rawElapsedMinutes: over.elapsed + (over.approvedExcludedMinutes ?? 0),
    approvedExcludedMinutes: over.approvedExcludedMinutes ?? 0,
    minutesRemaining: -variance,
    varianceMinutes: variance,
    adjustedTechnicianRating: over.rating,
    absoluteCompletionRating: over.rating,
    inFlight: over.inFlight ?? false,
  };
}

const SEDAN_GENERAL = kpi({ standardMinutes: 90, elapsed: 84, rating: 'EXCELLENT' });

const SUV_GENERAL = kpi({
  standardMinutes: 110,
  elapsed: 118,
  rating: 'MEETS_TARGET',
  vehicleClass: 'SUV_CLASS',
});

const GENERAL_PLUS_BRAKES = kpi({
  standardMinutes: 150,
  elapsed: 141,
  rating: 'EXCELLENT',
  packageType: 'GENERAL_SERVICE_FRONT_BRAKES',
  inFlight: true,
  approvedExcludedMinutes: 20,
});

const GENERAL_PLUS_BRAKES_PLUGS = kpi({
  standardMinutes: 195,
  elapsed: 210,
  rating: 'MEETS_TARGET',
  packageType: 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS',
  inFlight: true,
});

const RATING_FIXTURES: Array<{ rating: KpiRating; elapsed: number }> = [
  { rating: 'EXCELLENT', elapsed: 62 },
  { rating: 'MEETS_TARGET', elapsed: 102 },
  { rating: 'NEEDS_IMPROVEMENT', elapsed: 135 },
  { rating: 'BELOW_STANDARD', elapsed: 175 },
];

const LONG_PACKAGE_TYPE =
  'SUV General Service + Front Brakes + Spark Plugs + Extended Diagnostic Road Test and Emissions Pre-Check (Provisional Benchmark, Pending Manager Confirmation)';

/* --------------------------------- breakdowns --------------------------------- */

/** The canonical worked example from the specification, rendered verbatim. */
const CANONICAL: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service',
  basePackageMinutes: 90,
  lines: [
    {
      serviceCode: 'SVC-FUEL-FLT',
      serviceName: 'Fuel Filter Replacement',
      mode: 'ADDITIVE_STANDARD',
      minutes: 30,
      qualifierLabel: null,
      provisional: false,
      note: 'Genuine extra technician time, so it extends the standard.',
    },
    {
      serviceCode: 'SVC-TIRE-PRS',
      serviceName: 'Tire Pressure Check',
      mode: 'INCLUDED_IN_BASE',
      minutes: 0,
      qualifierLabel: 'Tyre · Pressure check',
      provisional: false,
      note: 'Already inside the General Service allowance.',
    },
    {
      serviceCode: 'SVC-EST-PREP',
      serviceName: 'Estimate Preparation',
      mode: 'SEPARATE_SLA',
      minutes: 20,
      qualifierLabel: null,
      provisional: false,
      note: 'Measured on the quotation SLA, not on this job clock.',
    },
  ],
  additiveMinutes: 30,
  finalStandardMinutes: 120,
  benchmarkSource: 'MANAGER_PACKAGE_PLUS_ADDITIVES',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [],
};

const FRONT_BRAKE_CONDITIONAL: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service + Front Brakes',
  basePackageMinutes: 150,
  lines: [
    {
      serviceCode: 'SVC-BRK-GEN',
      serviceName: 'Brake Service',
      mode: 'PACKAGE_COMPONENT',
      minutes: 0,
      qualifierLabel: 'Front · Pads',
      provisional: false,
      note: 'Conditional service. The qualifier resolved it to front pad work, which is what forms the General Service + Front Brakes package.',
    },
    {
      serviceCode: 'SVC-BRK-INSP',
      serviceName: 'Brake Inspection',
      mode: 'INCLUDED_IN_BASE',
      minutes: 0,
      qualifierLabel: 'Front · Inspection only',
      provisional: false,
      note: 'The same conditional service resolves the other way without repair: inspection sits inside the general service allowance.',
    },
  ],
  additiveMinutes: 0,
  finalStandardMinutes: 150,
  benchmarkSource: 'MANAGER_PACKAGE',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [],
};

const REAR_BRAKE_ADDITIVE: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service + Front Brakes',
  basePackageMinutes: 150,
  lines: [
    {
      serviceCode: 'SVC-BRK-RS',
      serviceName: 'Rear Brake Shoe Replacement',
      mode: 'ADDITIVE_STANDARD',
      minutes: 45,
      qualifierLabel: 'Rear · Shoes',
      provisional: false,
      note: 'The rear axle is outside the front-brake package, so it extends the standard.',
    },
    {
      serviceCode: 'SVC-BRK-RADJ',
      serviceName: 'Rear Brake Adjustment',
      mode: 'ADDITIVE_STANDARD',
      minutes: 20,
      qualifierLabel: 'Rear · Adjustment',
      provisional: false,
      suppressedAsDuplicate: true,
      note: 'Not counted: the shoe replacement above already covers adjustment, and one set of shoes is one job.',
    },
  ],
  additiveMinutes: 45,
  finalStandardMinutes: 195,
  benchmarkSource: 'MANAGER_PACKAGE_PLUS_ADDITIVES',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [],
};

const TIRE_PRESSURE_INCLUDED: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service',
  basePackageMinutes: 90,
  lines: [
    {
      serviceCode: 'SVC-TIRE-PRS',
      serviceName: 'Tire Pressure Check',
      mode: 'INCLUDED_IN_BASE',
      minutes: 0,
      qualifierLabel: 'Tyre · Pressure check',
      provisional: false,
      note: 'Inside the General Service allowance. It adds nothing and must not knock the job out of its package.',
    },
  ],
  additiveMinutes: 0,
  finalStandardMinutes: 90,
  benchmarkSource: 'MANAGER_PACKAGE',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [],
};

const TIRE_ROTATION_ADDITIVE: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service',
  basePackageMinutes: 90,
  lines: [
    {
      serviceCode: 'SVC-TIRE-ROT',
      serviceName: 'Tire Rotation',
      mode: 'ADDITIVE_STANDARD',
      minutes: 20,
      qualifierLabel: 'Tyre · Rotation',
      provisional: false,
      note: 'Physical tyre work rather than a check, so it extends the standard.',
    },
  ],
  additiveMinutes: 20,
  finalStandardMinutes: 110,
  benchmarkSource: 'MANAGER_PACKAGE_PLUS_ADDITIVES',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [],
};

const ESTIMATE_SEPARATE_SLA: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service',
  basePackageMinutes: 90,
  lines: [
    {
      serviceCode: 'SVC-EST-PREP',
      serviceName: 'Estimate Preparation',
      mode: 'SEPARATE_SLA',
      minutes: 20,
      qualifierLabel: null,
      provisional: false,
      note: 'Not technician repair time. It runs on its own quotation SLA and neither extends this standard nor voids it.',
    },
  ],
  additiveMinutes: 0,
  finalStandardMinutes: 90,
  benchmarkSource: 'MANAGER_PACKAGE',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [],
};

const MISSING_QUALIFIERS: KpiCalculationBreakdown = {
  packageLabel: 'Sedan General Service',
  basePackageMinutes: 90,
  lines: [
    {
      serviceCode: 'SVC-BRK-GEN',
      serviceName: 'Brake Service',
      mode: 'ADDITIVE_STANDARD',
      minutes: 0,
      qualifierLabel: null,
      provisional: false,
      note: 'No time can be allowed until the axle and work type are recorded.',
    },
    {
      serviceCode: 'SVC-TIRE-GEN',
      serviceName: 'Tire Service',
      mode: 'ADDITIVE_STANDARD',
      minutes: 0,
      qualifierLabel: null,
      provisional: false,
      note: 'A pressure check and a replacement are not the same allowance.',
    },
  ],
  additiveMinutes: 0,
  finalStandardMinutes: null,
  benchmarkSource: 'NOT_TECHNICIAN_RATED',
  vehicleClass: 'SEDAN_CLASS',
  provisionalDurationsUsed: false,
  missingQualifiers: [
    {
      serviceCode: 'SVC-BRK-GEN',
      message: 'Record the axle (front or rear) and the work type (pads, shoes, rotor, fluid).',
    },
    {
      serviceCode: 'SVC-TIRE-GEN',
      message: 'Record the tyre operation (rotation, balance, alignment, puncture repair, replacement).',
    },
  ],
};

const PROVISIONAL_DURATIONS: KpiCalculationBreakdown = {
  packageLabel: 'SUV General Service',
  basePackageMinutes: 110,
  lines: [
    {
      serviceCode: 'SVC-CAB-FLT',
      serviceName: 'Cabin Air Filter Replacement',
      mode: 'ADDITIVE_STANDARD',
      minutes: 25,
      qualifierLabel: null,
      provisional: true,
      note: 'No manager-agreed duration yet, so the catalogue estimate stands in.',
    },
    {
      serviceCode: 'SVC-FUEL-FLT',
      serviceName: 'Fuel Filter Replacement',
      mode: 'ADDITIVE_STANDARD',
      minutes: 30,
      qualifierLabel: null,
      provisional: false,
      note: null,
    },
  ],
  additiveMinutes: 55,
  finalStandardMinutes: 165,
  benchmarkSource: 'MANAGER_PACKAGE_PLUS_ADDITIVES',
  vehicleClass: 'SUV_CLASS',
  provisionalDurationsUsed: true,
  missingQualifiers: [],
};

const OVERFLOW: KpiCalculationBreakdown = {
  packageLabel:
    'SUV General Service + Front Brakes + Spark Plugs + Extended Diagnostic Road Test and Emissions Pre-Check',
  basePackageMinutes: 245,
  lines: [
    {
      serviceCode: 'SVC-DIAG-EXTENDED-ROADTEST-EMISSIONS-PRECHECK-01',
      serviceName:
        'Extended Diagnostic Road Test, Emissions Pre-Check and Onboard Diagnostics Fault Memory Readout',
      mode: 'ADDITIVE_STANDARD',
      minutes: 75,
      qualifierLabel: 'Front and rear · Pads, shoes, rotors and fluid bleed',
      provisional: true,
      note: 'A deliberately overlong name, code, qualifier and note together, to prove the panel wraps rather than clipping or pushing the minutes column off the card.',
    },
    {
      serviceCode: 'SVC-CUSTOMER-SUPPLIED-PARTS-FITMENT-ASSESSMENT-02',
      serviceName: 'Customer-Supplied Parts Fitment Assessment and Compatibility Verification',
      mode: 'SEPARATE_SLA',
      minutes: 40,
      qualifierLabel: null,
      provisional: false,
      note: null,
    },
  ],
  additiveMinutes: 75,
  finalStandardMinutes: 320,
  benchmarkSource: 'CATALOG_COMPOSITE',
  vehicleClass: 'SUV_CLASS',
  provisionalDurationsUsed: true,
  missingQualifiers: [
    {
      serviceCode: 'SVC-SUSPENSION-GEOMETRY-FOUR-WHEEL-ALIGNMENT-CHECK-03',
      message:
        'Record which corners were adjusted and whether a full four-wheel geometry reset was carried out, because the allowance differs substantially between them.',
    },
  ],
};

/* ----------------------------------- layout ----------------------------------- */

function Section({
  n,
  title,
  note,
  children,
}: {
  n: number;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <div className="flex items-baseline gap-2">
        <span className="badge bg-slate-900 text-white text-[10px] tabular-nums">
          {String(n).padStart(2, '0')}
        </span>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      </div>
      {note && <p className="mt-1 text-xs text-slate-500">{note}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

/** Stands in for the job-card context the strip normally sits inside. */
function JobContext({ services }: { services: string }) {
  return (
    <p className="text-[11px] text-slate-400">
      Ticket SAMPLE-01 · Plate SAMPLE-01 · A. Technician · {services}
    </p>
  );
}

export default function VisualQaKpiPage() {
  if (!visualQaEnabled()) notFound();

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <header>
          <h1 className="text-xl font-bold text-slate-900">KPI visual QA</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every rendering state of the KPI strip and the KPI calculation panel, on fixed
            synthetic fixtures.
          </p>
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900">
              Synthetic data. Development builds only.
            </p>
            <p className="mt-0.5 text-[11px] text-amber-800">
              Nothing on this page is fetched. Every customer, vehicle, technician and ticket
              reference is fabricated, so these screenshots are safe to attach to a ticket.
            </p>
          </div>
        </header>

        <Section n={1} title="Sedan General Service" note="Completed inside the standard.">
          <JobContext services="General Service" />
          <KpiStrip kpi={SEDAN_GENERAL} />
        </Section>

        <Section n={2} title="SUV General Service" note="Larger class allowance, finished slightly over.">
          <JobContext services="General Service" />
          <KpiStrip kpi={SUV_GENERAL} />
        </Section>

        <Section
          n={3}
          title="General Service + Front Brakes"
          note="In flight, with approved excluded time deducted from the raw clock."
        >
          <JobContext services="General Service, Front Brakes" />
          <KpiStrip kpi={GENERAL_PLUS_BRAKES} />
        </Section>

        <Section
          n={4}
          title="General Service + Front Brakes + Spark Plugs"
          note="The largest package, carrying both exception badges."
        >
          <JobContext services="General Service, Front Brakes, Spark Plugs" />
          <KpiStrip kpi={GENERAL_PLUS_BRAKES_PLUGS} delayPending hadRework />
        </Section>

        <Section
          n={5}
          title="Fuel-filter additive"
          note="The worked example: one additive, one included, one on a separate SLA."
        >
          <KpiCalculationPanel
            breakdown={CANONICAL}
            elapsedMinutes={108}
            projectedRating="EXCELLENT"
          />
        </Section>

        <Section
          n={6}
          title="Front-brake conditional"
          note="The same conditional service resolving two ways from its qualifier."
        >
          <KpiCalculationPanel breakdown={FRONT_BRAKE_CONDITIONAL} />
        </Section>

        <Section
          n={7}
          title="Rear-brake additive"
          note="Rear work extends the front-brake package; the duplicate code is struck through."
        >
          <KpiCalculationPanel breakdown={REAR_BRAKE_ADDITIVE} />
        </Section>

        <Section n={8} title="Tire-pressure included">
          <KpiCalculationPanel breakdown={TIRE_PRESSURE_INCLUDED} />
        </Section>

        <Section n={9} title="Tire-rotation additive">
          <KpiCalculationPanel breakdown={TIRE_ROTATION_ADDITIVE} />
        </Section>

        <Section n={10} title="Estimate separate-SLA">
          <KpiCalculationPanel breakdown={ESTIMATE_SEPARATE_SLA} />
        </Section>

        <Section
          n={11}
          title="Shared / reassigned job"
          note="Two technicians on one clock: job time is kept, the individual rating is refused."
        >
          <JobContext services="General Service, Front Brakes" />
          <KpiStrip kpi={GENERAL_PLUS_BRAKES} technicianCount={2} />
          <KpiStrip kpi={GENERAL_PLUS_BRAKES} technicianCount={2} variant="dense" />
        </Section>

        {RATING_FIXTURES.map((f, i) => (
          <Section
            key={f.rating}
            n={12 + i}
            title={
              f.rating === 'EXCELLENT'
                ? 'Excellent'
                : f.rating === 'MEETS_TARGET'
                  ? 'Meets Target'
                  : f.rating === 'NEEDS_IMPROVEMENT'
                    ? 'Needs Improvement'
                    : 'Below Standard'
            }
            note="In flight against a 90 minute standard, with the countdown to the next band."
          >
            <KpiStrip
              kpi={kpi({
                standardMinutes: 90,
                elapsed: f.elapsed,
                rating: f.rating,
                inFlight: true,
              })}
            />
            <KpiStrip
              kpi={kpi({
                standardMinutes: 90,
                elapsed: f.elapsed,
                rating: f.rating,
                inFlight: true,
              })}
              variant="dense"
            />
          </Section>
        ))}

        <Section
          n={16}
          title="Missing qualifier validation"
          note="Two unqualified lines block the standard outright."
        >
          <KpiCalculationPanel breakdown={MISSING_QUALIFIERS} />
        </Section>

        <Section
          n={17}
          title="Provisional duration warning"
          note="A stand-in duration, and an elapsed clock already past the standard."
        >
          <KpiCalculationPanel
            breakdown={PROVISIONAL_DURATIONS}
            elapsedMinutes={178}
            projectedRating="MEETS_TARGET"
          />
        </Section>

        <Section
          n={18}
          title="Long service and package names"
          note="Overflow test. The dense strip is boxed at a dispatch bay-card width."
        >
          <KpiCalculationPanel breakdown={OVERFLOW} />
          <KpiStrip
            kpi={kpi({
              standardMinutes: 320,
              elapsed: 298,
              rating: 'EXCELLENT',
              vehicleClass: 'SUV_CLASS',
              packageType: LONG_PACKAGE_TYPE,
              inFlight: true,
            })}
          />
          <div className="w-[260px]">
            <KpiStrip
              kpi={kpi({
                standardMinutes: 320,
                elapsed: 298,
                rating: 'EXCELLENT',
                vehicleClass: 'SUV_CLASS',
                packageType: LONG_PACKAGE_TYPE,
                inFlight: true,
              })}
              variant="dense"
            />
          </div>
        </Section>

        <Section
          n={19}
          title="Empty"
          note="No KPI payload at all. The strip renders nothing, so the host supplies the empty state."
        >
          <KpiStrip kpi={null} />
          <EmptyState
            title="No KPI figures for this job"
            description="Nothing has been recorded against this job yet."
          />
        </Section>

        <Section n={20} title="Loading">
          <LoadingState message="Loading KPI…" />
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-200" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-slate-200" />
          </div>
        </Section>

        <Section n={21} title="Error">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-xs font-semibold text-red-800">KPI figures could not be loaded</p>
            <p className="mt-0.5 text-[11px] text-red-700">
              The standard for this job is unavailable. It has not been recalculated, and no rating
              has been filed.
            </p>
            <button type="button" className="btn-secondary mt-3 text-xs">
              Retry
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}
