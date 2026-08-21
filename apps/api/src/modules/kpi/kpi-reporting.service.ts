import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

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
      },
    });

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
