import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { KpiService } from '../kpi.service';
import { detectPackage, type PackageComponentMap } from '../engine/package-detection';

/**
 * CR-2026-091 — an administrative gap must never read as a technician's failure.
 *
 * Leaving a service unmapped is acceptable temporarily. What is not acceptable is the
 * job silently becoming a bad result: the technician did the work, and nobody had yet
 * said what to measure it against. Three properties are protected here.
 *
 *   1. The job is UNRATED — no adjusted rating and no absolute band either. The
 *      absolute band needs no benchmark, which is exactly why it used to slip through
 *      and show "Below Standard" on a job whose unmapped extra work was the reason it
 *      ran long.
 *   2. It is distinguishable from a job that genuinely has no standard, so the gap can
 *      be found and closed rather than blending into a pile of custom jobs.
 *   3. It is out of every technician denominator, so it neither helps nor harms anyone.
 */

const OIL = 'svc-oil';
const BRK = 'svc-brk';
const TUNEUP = 'svc-tuneup';
const UNMAPPED = 'svc-unmapped';

const map: PackageComponentMap = new Map([
  [OIL, { componentRole: 'GENERAL_SERVICE_CORE', requiresAxleQualifier: false }],
  [BRK, { componentRole: 'FRONT_BRAKES', requiresAxleQualifier: true }],
  [TUNEUP, { componentRole: 'FORCES_CUSTOM_BENCHMARK', requiresAxleQualifier: false }],
]);

const line = (serviceTypeId: string, axlePosition?: 'FRONT' | 'REAR') => ({
  serviceTypeId,
  axlePosition,
});

describe('detection distinguishes a configuration gap from a real answer', () => {
  it('flags an unmapped service as needing benchmark review', () => {
    const r = detectPackage([line(OIL), line(UNMAPPED)], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.requiresBenchmarkReview).toBe(true);
  });

  it('flags a brake line with no axle as needing benchmark review', () => {
    const r = detectPackage([line(OIL), line(BRK)], map);
    expect(r.requiresBenchmarkReview).toBe(true);
  });

  it('does NOT flag work deliberately marked as forcing a custom benchmark', () => {
    // A manager already answered this one. No amount of configuration changes it.
    const r = detectPackage([line(OIL), line(TUNEUP)], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.requiresBenchmarkReview).toBe(false);
  });

  it('does NOT flag rear-only brake work', () => {
    // Rear brakes are not front brakes. That is a conclusion, not a gap.
    const r = detectPackage([line(OIL), line(BRK, 'REAR')], map);
    expect(r.requiresBenchmarkReview).toBe(false);
  });

  it('does NOT flag a combination that simply is not an approved package', () => {
    const r = detectPackage([line(BRK, 'FRONT')], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.requiresBenchmarkReview).toBe(false);
  });

  it('does not flag a job that benchmarks cleanly', () => {
    const r = detectPackage([line(OIL)], map);
    expect(r.packageType).toBe('GENERAL_SERVICE_ONLY');
    expect(r.requiresBenchmarkReview).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot behaviour
// ---------------------------------------------------------------------------

function build(overrides: Record<string, any> = {}) {
  const saved: any = {};
  const prisma: any = {
    serviceOrder: {
      findUnique: vi.fn(async () => ({
        startedAt: new Date('2026-08-21T09:00:00Z'),
        completedAt: new Date('2026-08-21T13:00:00Z'), // 240 min — well past every band
        assignments: [{ technicianId: 'tech-1', isPrimary: true }],
        items: [
          {
            id: 'line-1',
            serviceTypeId: OIL,
            status: 'PLANNED',
            axlePosition: null,
            brakeWorkType: null,
            tireOperation: null,
            unitQuantity: null,
            serviceType: { code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30 },
          },
        ],
        serviceVisit: { vehicle: { serviceClass: 'SEDAN_CLASS' } },
      })),
    },
    workOrderKpiSnapshot: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => Object.assign(saved, data)),
      update: vi.fn(async ({ data }: any) => Object.assign(saved, data)),
      findMany: vi.fn(async () => []),
    },
    kpiDelayEvent: { findMany: vi.fn(async () => []) },
    kpiPolicy: {
      findFirst: vi.fn(async () => policy),
      findUnique: vi.fn(async () => policy),
    },
    kpiServiceComponent: { findMany: vi.fn(async () => []) },
    businessRuleConfig: { findFirst: vi.fn(async () => null) },
    technician: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    ...overrides,
  };
  const audit = { log: vi.fn(async () => ({})) };
  return { service: new KpiService(prisma as any, audit as any), prisma, audit, saved };
}

const policy = {
  id: 'pol-1',
  version: 1,
  benchmarks: [
    { vehicleClass: 'SEDAN_CLASS', packageType: 'GENERAL_SERVICE_ONLY', standardMinutes: 90 },
  ],
  meetsToleranceMinutes: 30,
  needsImprovementToleranceMinutes: 60,
  absoluteExcellentMaxMinutes: 120,
  absoluteMeetsTargetMaxMinutes: 150,
  absoluteNeedsImprovementMaxMinutes: 180,
};

describe('a job held for benchmark review carries no rating at all', () => {
  it('gets PENDING_BENCHMARK_REVIEW, and neither rating', async () => {
    // No component mapping at all, so OIL-01 is unmapped: the exact situation the
    // seed's four deliberately-unmapped services would produce.
    const h = build();
    await h.service.captureSnapshotOnQc('so-1');

    expect(h.saved.eligibilityStatus).toBe('PENDING_BENCHMARK_REVIEW');
    expect(h.saved.pendingBenchmarkReview).toBe(true);
    expect(h.saved.adjustedTechnicianRating).toBeNull();
    // The point of the CR: a 240-minute job would otherwise be BELOW_STANDARD here.
    expect(h.saved.absoluteCompletionRating).toBeNull();
    expect(h.saved.onTarget).toBe(false);
  });

  it('still records the job and its times — unrated, never lost', async () => {
    const h = build();
    await h.service.captureSnapshotOnQc('so-1');

    expect(h.prisma.workOrderKpiSnapshot.create).toHaveBeenCalled();
    expect(h.saved.rawElapsedMinutes).toBe(240);
    expect(h.saved.firstWorkStartedAt).toBeInstanceOf(Date);
    expect(h.saved.eligibilityReason).toMatch(/no KPI contribution policy/i);
  });

  it('a job with a genuine no-standard answer keeps its absolute band', async () => {
    // The distinction in practice: a deliberate custom job is a finished answer, so
    // CR-2026-088's decision to apply the absolute band still holds for it.
    const h = build({
      kpiServiceComponent: {
        findMany: vi.fn(async () => [
          {
            serviceTypeId: OIL,
            componentRole: 'FORCES_CUSTOM_BENCHMARK',
            contributionMode: 'CUSTOM_ONLY',
            durationSource: 'NO_DURATION',
            fixedSedanMinutes: null,
            fixedSuvMinutes: null,
            allowanceBasis: 'PER_JOB',
            requiredQualifier: 'NONE',
            provisionalDuration: false,
            requiresAxleQualifier: false,
          },
        ]),
      },
    });
    await h.service.captureSnapshotOnQc('so-1');

    expect(h.saved.eligibilityStatus).toBe('NOT_BENCHMARKED');
    expect(h.saved.pendingBenchmarkReview).toBe(false);
    expect(h.saved.absoluteCompletionRating).toBe('BELOW_STANDARD');
    expect(h.saved.adjustedTechnicianRating).toBeNull();
  });
});

describe('resolving the review once the configuration exists', () => {
  const pending = {
    id: 'snap-1',
    serviceOrderId: 'so-1',
    policyId: 'pol-1',
    pendingBenchmarkReview: true,
    vehicleClass: 'SEDAN_CLASS',
    packageType: 'CUSTOM_UNBENCHMARKED',
    standardMinutes: null,
    customStandardMinutes: null,
    primaryTechnicianId: 'tech-1',
    firstWorkStartedAt: new Date('2026-08-21T09:00:00Z'),
    firstSubmittedToQcAt: new Date('2026-08-21T10:30:00Z'), // 90 min — exactly standard
    eligibilityStatus: 'PENDING_BENCHMARK_REVIEW',
  };

  const mapped = {
    kpiServiceComponent: {
      findMany: vi.fn(async () => [
        {
          serviceTypeId: OIL,
          componentRole: 'GENERAL_SERVICE_CORE',
          contributionMode: 'PACKAGE_COMPONENT',
          durationSource: 'MANAGER_PACKAGE',
          fixedSedanMinutes: null,
          fixedSuvMinutes: null,
          allowanceBasis: 'PER_JOB',
          requiredQualifier: 'NONE',
          provisionalDuration: false,
          requiresAxleQualifier: false,
        },
      ]),
    },
  };

  it('rates the job for the first time and stamps who resolved it', async () => {
    const h = build({
      ...mapped,
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => pending),
        update: vi.fn(async ({ data }: any) => data),
        create: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });

    const r = await h.service.resolveBenchmarkReview('so-1', 'mgr-1');

    expect(r.eligibilityStatus).toBe('ELIGIBLE');
    expect(r.pendingBenchmarkReview).toBe(false);
    expect(r.adjustedTechnicianRating).toBe('EXCELLENT'); // 90 vs 90 → variance 0
    expect(r.benchmarkResolvedByUserId).toBe('mgr-1');
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'KPI_BENCHMARK_REVIEW_RESOLVED' }),
    );
  });

  it('refuses a job that already carries a rating', async () => {
    // The immutability rule still holds: this path produces a FIRST rating, it never
    // replaces one.
    const h = build({
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => ({ ...pending, pendingBenchmarkReview: false })),
        update: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });

    await expect(h.service.resolveBenchmarkReview('so-1', 'mgr-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(h.service.resolveBenchmarkReview('so-1', 'mgr-1')).rejects.toThrow(
      /already carries a rating/i,
    );
  });

  it('refuses while the configuration is still missing', async () => {
    const h = build({
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => pending),
        update: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });

    await expect(h.service.resolveBenchmarkReview('so-1', 'mgr-1')).rejects.toThrow(
      /still awaiting configuration/i,
    );
  });
});
