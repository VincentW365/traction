import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { computeLabourMeasures } from './engine/labour-measures';

/**
 * Carried on the report AND on every row, so it survives a CSV export — the caveat
 * that only lives in a heading is the caveat that gets lost the moment someone
 * downloads the data and mails it round.
 */
const SHARED_JOBS_NOTE =
  'Informational only — not included in individual KPI comparison.';

/**
 * CR-2026-088 — the manager KPI dashboard.
 *
 * Reports median and percentiles alongside averages on purpose. A mean is easy to
 * wreck: one job that sat overnight because a part never arrived drags a
 * technician's average into Below Standard and hides an otherwise steady month.
 * The median says what a typical job looks like; p75/p90 say how bad the tail gets.
 *
 * Nothing here ranks a technician without also reporting how many jobs the number
 * rests on, and shared or reassigned jobs are excluded from individual comparison
 * while remaining in the detail — attributing a whole elapsed time to whoever
 * happened to finish it would be a lie.
 */
@Injectable()
export class KpiReportingService {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(q: Record<string, string>): Prisma.WorkOrderKpiSnapshotWhereInput {
    const where: Prisma.WorkOrderKpiSnapshotWhereInput = {};

    if (q.from || q.to) {
      where.firstSubmittedToQcAt = {};
      if (q.from) where.firstSubmittedToQcAt.gte = new Date(`${q.from}T00:00:00.000Z`);
      if (q.to) where.firstSubmittedToQcAt.lte = new Date(`${q.to}T23:59:59.999Z`);
    }
    if (q.technicianId) where.primaryTechnicianId = q.technicianId;
    if (q.vehicleClass) where.vehicleClass = q.vehicleClass as never;
    if (q.packageType) where.packageType = q.packageType as never;
    if (q.adjustedRating) where.adjustedTechnicianRating = q.adjustedRating as never;
    if (q.absoluteRating) where.absoluteCompletionRating = q.absoluteRating as never;
    if (q.hadRework === 'true') where.hadRework = true;
    if (q.hadRework === 'false') where.hadRework = false;
    if (q.benchmarkedOnly === 'true') where.packageType = { not: 'CUSTOM_UNBENCHMARKED' };
    if (q.eligibility) where.eligibilityStatus = q.eligibility as never;

    return where;
  }

  async getJobRows(q: Record<string, string>) {
    const rows = await this.prisma.workOrderKpiSnapshot.findMany({
      where: this.buildWhere(q),
      orderBy: { firstSubmittedToQcAt: 'desc' },
      take: Math.min(Number(q.take ?? 500), 2000),
      include: {
        serviceOrder: {
          select: {
            id: true,
            serviceVisit: {
              select: {
                queueTicket: { select: { ticketNumber: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
    });

    const techIds = [...new Set(rows.map((r) => r.primaryTechnicianId).filter(Boolean))];
    const techs = techIds.length
      ? await this.prisma.technician.findMany({
          where: { id: { in: techIds as string[] } },
          select: { id: true, employeeCode: true, userAccount: { select: { fullName: true } } },
        })
      : [];
    const techById = new Map(techs.map((t) => [t.id, t]));

    return rows.map((r) => {
      const tech = r.primaryTechnicianId ? techById.get(r.primaryTechnicianId) : null;
      const ticket = r.serviceOrder?.serviceVisit?.queueTicket;
      return {
        serviceOrderId: r.serviceOrderId,
        ticketNumber: ticket?.ticketNumber ?? null,
        plate: r.serviceOrder?.serviceVisit?.vehicle?.plateNumber ?? null,
        technicianCode: tech?.employeeCode ?? null,
        technicianName: tech?.userAccount?.fullName ?? null,
        vehicleClass: r.vehicleClass,
        packageType: r.packageType,
        standardMinutes: r.standardMinutes,
        rawElapsedMinutes: r.rawElapsedMinutes,
        approvedExcludedMinutes: r.approvedExcludedMinutes,
        kpiCompletionMinutes: r.kpiCompletionMinutes,
        varianceMinutes: r.varianceMinutes,
        variancePercent: r.variancePercent,
        absoluteCompletionRating: r.absoluteCompletionRating,
        adjustedTechnicianRating: r.adjustedTechnicianRating,
        onTarget: r.onTarget,
        eligibilityStatus: r.eligibilityStatus,
        eligibilityReason: r.eligibilityReason,
        // CR-2026-091 — unrated because configuration is missing, not because the
        // technician did badly. Carried on the row so a CSV keeps the distinction.
        pendingBenchmarkReview: r.pendingBenchmarkReview,
        benchmarkResolvedAt: r.benchmarkResolvedAt,
        isSharedOrReassigned: r.isSharedOrReassigned,
        hadRework: r.hadRework,
        // Every row carries the policy it was rated under, so a CSV can be
        // reconciled months later even after the standards change.
        policyVersion: r.policyVersion,
        firstWorkStartedAt: r.firstWorkStartedAt,
        firstSubmittedToQcAt: r.firstSubmittedToQcAt,
      };
    });
  }

  /**
   * CR-2026-090 — jobs more than one technician worked on.
   *
   * Its own report, not a dashboard filter. These jobs are excluded from individual
   * comparison by design, and the surest way to have them compared anyway is to leave
   * them sitting in the ranking view behind a checkbox.
   *
   * What it does NOT do is split the job's elapsed time between the technicians. The
   * data cannot support that split — no formula turns "two people were on this job"
   * into "Marcus did 62% of it" — and the CR is explicit that none may be invented.
   * What it reports instead is measured: who was on the job, how long each was
   * actually working, and how much of that was side by side.
   */
  async getSharedJobs(q: Record<string, string>) {
    const where: Prisma.WorkOrderKpiSnapshotWhereInput = {
      ...this.buildWhere(q),
      isSharedOrReassigned: true,
    };
    // technicianId filters on the PRIMARY technician for the main dashboard, but a
    // shared-jobs report is exactly where "jobs Marcus helped on" matters, so the
    // filter is applied against the segments instead.
    //
    // Resolved into the query rather than applied to the results, because the row cap
    // would otherwise bite BEFORE the filter: a wide date range would return the most
    // recent 300 shared jobs and then show only the handful this technician appears
    // in, which reads as "they worked on 4 shared jobs" when they worked on forty.
    delete where.primaryTechnicianId;

    if (q.technicianId) {
      const theirOrders = await this.prisma.technicianWorkSegment.findMany({
        where: { technicianId: q.technicianId },
        select: { serviceOrderId: true },
        distinct: ['serviceOrderId'],
      });
      where.serviceOrderId = { in: theirOrders.map((s) => s.serviceOrderId) };
    }

    const snapshots = await this.prisma.workOrderKpiSnapshot.findMany({
      where,
      orderBy: { firstSubmittedToQcAt: 'desc' },
      take: Math.min(Number(q.take ?? 300), 1000),
      include: {
        serviceOrder: {
          select: {
            id: true,
            serviceVisit: {
              select: {
                queueTicket: { select: { ticketNumber: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
    });

    if (snapshots.length === 0) {
      return {
        rows: [],
        note: SHARED_JOBS_NOTE,
        // Same shape as the populated path — a client should not have to handle two.
        totals: {
          jobs: 0,
          teamLabourMinutes: 0,
          activeCoverageMinutes: 0,
          concurrentAssistMinutes: 0,
          excludedCoverageMinutes: 0,
        },
      };
    }

    const orderIds = snapshots.map((s) => s.serviceOrderId);
    const segments = await this.prisma.technicianWorkSegment.findMany({
      where: { serviceOrderId: { in: orderIds } },
      select: {
        serviceOrderId: true,
        technicianId: true,
        startedAt: true,
        endedAt: true,
        roleSnapshot: true,
        startSource: true,
        endReason: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    const exclusions = await this.prisma.kpiDelayEvent.findMany({
      where: {
        serviceOrderId: { in: orderIds },
        requestedForExclusion: true,
        approvalStatus: 'APPROVED',
      },
      select: { serviceOrderId: true, startedAt: true, endedAt: true },
    });

    const techIds = [...new Set(segments.map((s) => s.technicianId))];
    const techs = techIds.length
      ? await this.prisma.technician.findMany({
          where: { id: { in: techIds } },
          select: { id: true, employeeCode: true, userAccount: { select: { fullName: true } } },
        })
      : [];
    const techById = new Map(techs.map((t) => [t.id, t]));

    const segmentsByOrder = new Map<string, typeof segments>();
    for (const s of segments) {
      const list = segmentsByOrder.get(s.serviceOrderId);
      if (list) list.push(s);
      else segmentsByOrder.set(s.serviceOrderId, [s]);
    }
    const exclusionsByOrder = new Map<string, typeof exclusions>();
    for (const e of exclusions) {
      const list = exclusionsByOrder.get(e.serviceOrderId);
      if (list) list.push(e);
      else exclusionsByOrder.set(e.serviceOrderId, [e]);
    }

    // Snapshots are finished jobs, so "now" only matters for a segment somebody left
    // open. Measuring such a segment to the moment the job reached QC is the honest
    // bound — a technician cannot have been working on it after that.
    const rows = snapshots
      .map((s) => {
        const own = segmentsByOrder.get(s.serviceOrderId) ?? [];
        const bound = s.firstSubmittedToQcAt ?? new Date();
        const labour = computeLabourMeasures(
          own,
          exclusionsByOrder.get(s.serviceOrderId) ?? [],
          bound,
        );

        const ticket = s.serviceOrder?.serviceVisit?.queueTicket;
        return {
          serviceOrderId: s.serviceOrderId,
          ticketNumber: ticket?.ticketNumber ?? null,
          plate: s.serviceOrder?.serviceVisit?.vehicle?.plateNumber ?? null,
          vehicleClass: s.vehicleClass,
          packageType: s.packageType,
          standardMinutes: s.standardMinutes,
          kpiCompletionMinutes: s.kpiCompletionMinutes,
          policyVersion: s.policyVersion,
          firstWorkStartedAt: s.firstWorkStartedAt,
          firstSubmittedToQcAt: s.firstSubmittedToQcAt,
          hadRework: s.hadRework,

          technicianCount: labour.technicianCount,
          teamLabourMinutes: labour.teamLabourMinutes,
          activeCoverageMinutes: labour.activeCoverageMinutes,
          concurrentAssistMinutes: labour.concurrentAssistMinutes,
          excludedCoverageMinutes: labour.excludedCoverageMinutes,

          wasReassigned: own.some(
            (x) => x.endReason === 'REASSIGNED' || x.startSource === 'REASSIGNMENT',
          ),

          technicians: labour.perTechnician.map((t) => {
            const tech = techById.get(t.technicianId);
            const first = own.find((x) => x.technicianId === t.technicianId);
            return {
              technicianId: t.technicianId,
              technicianCode: tech?.employeeCode ?? null,
              technicianName: tech?.userAccount?.fullName ?? null,
              role: first?.roleSnapshot ?? null,
              activeMinutes: t.activeMinutes,
              segmentCount: t.segmentCount,
            };
          }),

          // No per-technician rating. Stated on the row itself so it survives a CSV
          // export, where the explanatory note at the top of the screen does not.
          individualRating: null as null,
          note: SHARED_JOBS_NOTE,
        };
      });

    return {
      rows,
      note: SHARED_JOBS_NOTE,
      // All four measures, so a client never has to reconstruct one of them from the
      // rows and end up with a total that disagrees in kind with the others.
      totals: {
        jobs: rows.length,
        teamLabourMinutes: rows.reduce((a, r) => a + r.teamLabourMinutes, 0),
        activeCoverageMinutes: rows.reduce((a, r) => a + r.activeCoverageMinutes, 0),
        concurrentAssistMinutes: rows.reduce((a, r) => a + r.concurrentAssistMinutes, 0),
        excludedCoverageMinutes: rows.reduce((a, r) => a + r.excludedCoverageMinutes, 0),
      },
    };
  }

  async getDashboard(q: Record<string, string>) {
    const where = this.buildWhere(q);
    const snapshots = await this.prisma.workOrderKpiSnapshot.findMany({
      where,
      select: {
        kpiCompletionMinutes: true,
        varianceMinutes: true,
        approvedExcludedMinutes: true,
        adjustedTechnicianRating: true,
        absoluteCompletionRating: true,
        onTarget: true,
        vehicleClass: true,
        packageType: true,
        eligibilityStatus: true,
        isSharedOrReassigned: true,
        hadRework: true,
        primaryTechnicianId: true,
        pendingBenchmarkReview: true,
      },
    });

    // CR-2026-091 — the denominator rule, stated once.
    //
    // A job counts towards a technician's numbers only when it is formally ELIGIBLE.
    // That excludes, among others, jobs held for benchmark review: the technician did
    // the work, but nobody had said what to measure it against, so counting it either
    // way would charge them for an administrative gap. It previously lived only as a
    // filter in the dashboard page, which meant every other consumer — CSV export, any
    // future report — had to remember to repeat it.
    const eligible = snapshots.filter((s) => s.eligibilityStatus === 'ELIGIBLE');
    const minutes = eligible
      .map((s) => s.kpiCompletionMinutes)
      .filter((m): m is number => m != null);
    const variances = eligible
      .map((s) => s.varianceMinutes)
      .filter((v): v is number => v != null);

    const ratingCount = (r: string) =>
      eligible.filter((s) => s.adjustedTechnicianRating === r).length;

    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

    const reworked = snapshots.filter((s) => s.hadRework).length;

    // Per-technician roll-up, computed here rather than in the page, so the exclusion
    // rule above is the one that applies — and so the numbers cover every job in range
    // rather than the first N rows the job table happened to fetch.
    //
    // Shared and reassigned jobs come out too: attributing a whole elapsed time to
    // whoever happened to finish it would be a lie.
    const individuallyComparable = eligible.filter(
      (s) => !s.isSharedOrReassigned && s.primaryTechnicianId,
    );

    const techIds = [
      ...new Set(individuallyComparable.map((s) => s.primaryTechnicianId as string)),
    ];
    const techs = techIds.length
      ? await this.prisma.technician.findMany({
          where: { id: { in: techIds } },
          select: { id: true, employeeCode: true, userAccount: { select: { fullName: true } } },
        })
      : [];
    const techById = new Map(techs.map((t) => [t.id, t]));

    const byTechnician = techIds
      .map((id) => {
        const theirs = individuallyComparable.filter((s) => s.primaryTechnicianId === id);
        const vs = theirs
          .map((s) => s.varianceMinutes)
          .filter((v): v is number => v != null);
        const t = techById.get(id);
        return {
          technicianId: id,
          technicianCode: t?.employeeCode ?? null,
          technicianName: t?.userAccount?.fullName ?? null,
          // Never a rating without the sample it rests on.
          jobs: theirs.length,
          onTarget: theirs.filter((s) => s.onTarget).length,
          onTargetPercent: pct(theirs.filter((s) => s.onTarget).length, theirs.length),
          medianVarianceMinutes: percentile(vs, 50),
          p75VarianceMinutes: percentile(vs, 75),
          // Reported so a manager can see WHY someone's job count is lower than
          // expected, instead of reading it as a quiet month.
          excludedPendingReview: snapshots.filter(
            (s) => s.primaryTechnicianId === id && s.pendingBenchmarkReview,
          ).length,
          excludedSharedOrReassigned: snapshots.filter(
            (s) => s.primaryTechnicianId === id && s.isSharedOrReassigned,
          ).length,
        };
      })
      .sort((a, b) => b.onTargetPercent - a.onTargetPercent);

    const exclusionByReason = await this.prisma.kpiDelayEvent.groupBy({
      by: ['reasonCode'],
      where: { approvalStatus: 'APPROVED', requestedForExclusion: true },
      _sum: { durationMinutes: true },
      _count: { _all: true },
    });

    return {
      // Never present a rating without the sample it rests on.
      eligibleJobs: eligible.length,
      totalJobs: snapshots.length,

      adjustedOnTargetPercent: pct(eligible.filter((s) => s.onTarget).length, eligible.length),
      excellentPercent: pct(ratingCount('EXCELLENT'), eligible.length),
      meetsTargetPercent: pct(ratingCount('MEETS_TARGET'), eligible.length),
      needsImprovementPercent: pct(ratingCount('NEEDS_IMPROVEMENT'), eligible.length),
      belowStandardPercent: pct(ratingCount('BELOW_STANDARD'), eligible.length),

      averageKpiMinutes: mean(minutes),
      medianKpiMinutes: percentile(minutes, 50),
      p75KpiMinutes: percentile(minutes, 75),
      p90KpiMinutes: percentile(minutes, 90),
      averageVarianceMinutes: mean(variances),
      medianVarianceMinutes: percentile(variances, 50),

      firstPassQcPercent: pct(snapshots.length - reworked, snapshots.length),
      reworkRate: pct(reworked, snapshots.length),

      byVehicleClass: groupCount(eligible, (s) => s.vehicleClass ?? 'UNCLASSIFIED'),
      byPackage: groupCount(snapshots, (s) => s.packageType),
      byAbsoluteRating: groupCount(
        eligible,
        (s) => s.absoluteCompletionRating ?? 'UNRATED',
      ),
      byIneligibility: groupCount(
        snapshots.filter((s) => s.eligibilityStatus !== 'ELIGIBLE'),
        (s) => s.eligibilityStatus,
      ),

      unbenchmarkedJobs: snapshots.filter((s) => s.packageType === 'CUSTOM_UNBENCHMARKED')
        .length,
      sharedOrReassignedJobs: snapshots.filter((s) => s.isSharedOrReassigned).length,

      // CR-2026-091 — jobs held because configuration is missing, reported separately
      // from jobs that genuinely have no standard. Both are unrated; only this one is
      // somebody's outstanding task, and a count nobody sees is a gap that never gets
      // closed. Excluded from every denominator above by the `eligible` filter.
      pendingBenchmarkReviewJobs: snapshots.filter((s) => s.pendingBenchmarkReview).length,

      byTechnician,

      approvedExclusionMinutesByReason: exclusionByReason.map((r) => ({
        reasonCode: r.reasonCode,
        minutes: r._sum.durationMinutes ?? 0,
        events: r._count._all,
      })),
    };
  }
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
}

/** Nearest-rank percentile. Small samples are common here, so no interpolation. */
function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function groupCount<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
