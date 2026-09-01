import { Injectable } from '@nestjs/common';
import { localDayRange } from './date-range';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { serviceVisitIsLive } from '../../common/helpers/operational-scope';
import {
  rateCompletionMinutes,
  parseKpiBands,
  DEFAULT_KPI_BANDS,
  type KpiBand,
  type KpiRating,
} from '../../common/helpers/kpi-rating';

export interface TechnicianEfficiencyRow {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  jobsCompleted: number;
  primaryJobs: number;
  helperJobs: number;
  avgJobMinutes: number;
  flaggedMinutes: number;
  clockMinutes: number;
  efficiencyPercent: number;
  // Quality: of the jobs this tech was PRIMARY on, how many came back (rework),
  // and the resulting first-time-fix rate. null when they had no primary jobs.
  reworkedJobs: number;
  firstTimeFixRate: number | null;
  // CR-2026-086 - the manager KPI benchmark, rated on average completion time.
  // null when the technician completed no jobs in the range (no time to rate).
  kpiRating: KpiRating | null;
}

export interface AssignmentHistoryRow {
  id: string;
  serviceOrderId: string;
  technicianName: string;
  employeeCode: string;
  isPrimary: boolean;
  status: string;
  assignedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  customerName: string;
  vehiclePlate: string;
}

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * CR-2026-086 — the manager's KPI rating bands, from BusinessRuleConfig.
   * Falls back to the supplied benchmark if the rule is absent or malformed;
   * Settings is a raw JSON editor, so this must never throw.
   */
  private async getKpiBands(): Promise<KpiBand[]> {
    const rule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'kpi_rating_bands', effectiveTo: null },
    });
    return rule ? parseKpiBands(rule.valueJson) : DEFAULT_KPI_BANDS;
  }

  async getTechnicianEfficiency(
    siteId: string,
    startDate: string,
    endDate: string,
  ): Promise<TechnicianEfficiencyRow[]> {
    // CR-2026-100 — the operator's local calendar day, not a UTC/local mix.
    const { start, end } = localDayRange(startDate, endDate);

    // CR-2026-086 — rating thresholds are a manager-tunable business rule, not a
    // constant, so they are read per call rather than baked in.
    const bands = await this.getKpiBands();

    const technicians = await this.prisma.technician.findMany({
      where: { homeSiteId: siteId, status: 'ACTIVE' },
      include: {
        userAccount: { select: { fullName: true } },
        assignments: {
          where: {
            assignedAt: { gte: start, lte: end },
            // CR-2026-006: exclude assignments tied to HISTORICAL_IMPORT visits.
            // serviceOrder + serviceVisit are required relations, so this only
            // filters historical rows (no effect on live data).
            serviceOrder: { serviceVisit: serviceVisitIsLive() },
          },
          include: {
            serviceOrder: {
              include: {
                items: { select: { estimateMinutes: true, actualMinutes: true } },
                _count: { select: { reworks: true } },
              },
            },
          },
        },
      },
    });

    return technicians.map((tech) => {
      let flaggedMinutes = 0;
      let clockMinutes = 0;
      let jobsCompleted = 0;
      let primaryJobs = 0;
      let helperJobs = 0;
      let reworkedJobs = 0;

      for (const assignment of tech.assignments) {
        // Clock time = actual time worked on this assignment
        if (assignment.startedAt && assignment.endedAt) {
          clockMinutes += Math.round(
            (assignment.endedAt.getTime() - assignment.startedAt.getTime()) / 60000,
          );
        }

        if (assignment.isPrimary) {
          primaryJobs++;
          // Flagged time = sum of estimated minutes for order items (primary only)
          for (const item of assignment.serviceOrder?.items ?? []) {
            flaggedMinutes += item.estimateMinutes ?? 0;
          }
          // Quality: this primary job came back if its order has rework records.
          if ((assignment.serviceOrder?._count?.reworks ?? 0) > 0) reworkedJobs++;
        } else {
          helperJobs++;
        }

        if (assignment.status === 'COMPLETED') {
          jobsCompleted++;
        }
      }

      const efficiencyPercent =
        clockMinutes > 0 ? Math.round((flaggedMinutes / clockMinutes) * 100) : 0;
      const avgJobMinutes = jobsCompleted > 0 ? Math.round(clockMinutes / jobsCompleted) : 0;
      const firstTimeFixRate =
        primaryJobs > 0 ? Math.round((1 - reworkedJobs / primaryJobs) * 1000) / 10 : null;

      return {
        technicianId: tech.id,
        employeeCode: tech.employeeCode,
        fullName: tech.userAccount.fullName,
        jobsCompleted,
        primaryJobs,
        helperJobs,
        avgJobMinutes,
        flaggedMinutes,
        clockMinutes,
        efficiencyPercent,
        reworkedJobs,
        firstTimeFixRate,
        kpiRating: rateCompletionMinutes(avgJobMinutes || null, bands),
      };
    });
  }

  async getTechnicianPerformance(technicianId: string, startDate: string, endDate: string) {
    // CR-2026-100 — the operator's local calendar day, not a UTC/local mix.
    const { start, end } = localDayRange(startDate, endDate);

    const tech = await this.prisma.technician.findUnique({
      where: { id: technicianId },
      include: { userAccount: { select: { fullName: true } } },
    });

    const assignments = await this.prisma.technicianAssignment.findMany({
      where: {
        technicianId,
        assignedAt: { gte: start, lte: end },
        // CR-2026-006: exclude HISTORICAL_IMPORT visits (required relations → live-only filter).
        serviceOrder: { serviceVisit: serviceVisitIsLive() },
      },
      include: {
        serviceOrder: {
          include: {
            items: { include: { serviceType: { select: { name: true, family: true } } } },
            _count: { select: { reworks: true } },
            serviceVisit: {
              select: {
                customer: { select: { firstName: true, lastName: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    const totalJobs = assignments.filter((a) => a.status === 'COMPLETED').length;
    let totalClockMinutes = 0;
    let totalFlaggedMinutes = 0;
    let primaryJobs = 0;
    let helperJobs = 0;
    let reworkedJobs = 0;

    for (const a of assignments) {
      if (a.startedAt && a.endedAt) {
        totalClockMinutes += Math.round(
          (a.endedAt.getTime() - a.startedAt.getTime()) / 60000,
        );
      }
      if (a.isPrimary) {
        primaryJobs++;
        for (const item of a.serviceOrder?.items ?? []) {
          totalFlaggedMinutes += item.estimateMinutes ?? 0;
        }
        if ((a.serviceOrder?._count?.reworks ?? 0) > 0) reworkedJobs++;
      } else {
        helperJobs++;
      }
    }

    const avgJobMinutes = totalJobs > 0 ? Math.round(totalClockMinutes / totalJobs) : 0;
    const efficiencyPercent = totalClockMinutes > 0
      ? Math.round((totalFlaggedMinutes / totalClockMinutes) * 100)
      : 0;
    const firstTimeFixRate =
      primaryJobs > 0 ? Math.round((1 - reworkedJobs / primaryJobs) * 1000) / 10 : null;

    return {
      technicianId,
      employeeCode: tech?.employeeCode ?? '',
      fullName: tech?.userAccount.fullName ?? '',
      totalJobs,
      primaryJobs,
      helperJobs,
      totalClockMinutes,
      totalFlaggedMinutes,
      avgJobMinutes,
      efficiencyPercent,
      reworkedJobs,
      firstTimeFixRate,
      assignments: assignments.map((a) => ({
        id: a.id,
        isPrimary: a.isPrimary,
        status: a.status,
        reworked: (a.serviceOrder?._count?.reworks ?? 0) > 0,
        assignedAt: a.assignedAt.toISOString(),
        startedAt: a.startedAt?.toISOString() ?? null,
        endedAt: a.endedAt?.toISOString() ?? null,
        durationMinutes: a.startedAt && a.endedAt
          ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 60000)
          : null,
        customerName: a.serviceOrder?.serviceVisit
          ? `${a.serviceOrder.serviceVisit.customer.firstName} ${a.serviceOrder.serviceVisit.customer.lastName}`
          : '',
        vehiclePlate: a.serviceOrder?.serviceVisit?.vehicle.plateNumber ?? '',
        services: a.serviceOrder?.items.map((i) => i.serviceType.name) ?? [],
      })),
    };
  }

  async getAssignmentHistory(
    siteId: string,
    startDate: string,
    endDate: string,
    includeHistorical = false,
  ) {
    // CR-2026-100 — the operator's local calendar day, not a UTC/local mix.
    const { start, end } = localDayRange(startDate, endDate);

    const assignments = await this.prisma.technicianAssignment.findMany({
      where: {
        assignedAt: { gte: start, lte: end },
        technician: { homeSiteId: siteId },
        // CR-2026-006: exclude HISTORICAL_IMPORT visits by default; opt-in via includeHistorical.
        serviceOrder: { serviceVisit: serviceVisitIsLive(includeHistorical) },
      },
      include: {
        technician: {
          select: { employeeCode: true, userAccount: { select: { fullName: true } } },
        },
        serviceOrder: {
          select: {
            id: true,
            status: true,
            serviceVisit: {
              select: {
                customer: { select: { firstName: true, lastName: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
      take: 200,
    });

    return assignments.map((a) => ({
      id: a.id,
      serviceOrderId: a.serviceOrder.id,
      technicianName: a.technician.userAccount.fullName,
      employeeCode: a.technician.employeeCode,
      isPrimary: a.isPrimary,
      status: a.status,
      assignedAt: a.assignedAt.toISOString(),
      startedAt: a.startedAt?.toISOString() ?? null,
      endedAt: a.endedAt?.toISOString() ?? null,
      durationMinutes: a.startedAt && a.endedAt
        ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 60000)
        : null,
      customerName: a.serviceOrder.serviceVisit
        ? `${a.serviceOrder.serviceVisit.customer.firstName} ${a.serviceOrder.serviceVisit.customer.lastName}`
        : '',
      vehiclePlate: a.serviceOrder.serviceVisit?.vehicle.plateNumber ?? '',
    }));
  }
}
