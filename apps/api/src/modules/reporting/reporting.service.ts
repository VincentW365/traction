import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  liveVisitWhere,
  liveVisitSql,
  historicalVisitWhere,
  historicalVisitSql,
} from '../../common/helpers/operational-scope';

export interface KpiResult {
  code: string;
  name: string;
  value: number | string | null;
  target: string | null;
}

export interface TrendDataPoint {
  date: string;
  value: number;
}

export type TrendMetric = 'check_ins' | 'wait_time' | 'no_shows' | 'overrides';

export interface TechnicianUtilizationRow {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  totalAssignments: number;
  totalMinutesWorked: number;
  utilizationPercent: number;
}

export interface ServiceFamilyBreakdownRow {
  family: string;
  count: number;
  totalDurationMinutes: number;
}

export interface MaintenanceRetentionResult {
  overdue: number;
  upcoming: number;
  total: number;
  retentionOpportunities: number;
}

export interface QueuePerformanceSummary {
  avgRankChanges: number;
  avgScoreAtService: number | null;
  overrideRate: number;
  totalVisits: number;
  totalOverrides: number;
}

@Injectable()
export class ReportingService {
  constructor(private prisma: PrismaService) {}

  async getKpis(
    siteId: string,
    startDate: string,
    endDate: string,
    includeHistorical = false,
  ): Promise<KpiResult[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const [
      totalCheckedIn,
      appointmentCount,
      walkinCount,
      missedCount,
      cancelledCount,
      overrideCount,
      avgWaitMinutes,
    ] = await Promise.all([
      // Total checked-in visits (excludes HISTORICAL_IMPORT by default)
      this.prisma.serviceVisit.count({
        where: {
          siteId,
          checkedInAt: { gte: start, lte: end },
          ...liveVisitWhere(includeHistorical),
        },
      }),

      // Appointment count — explicit sourceType already excludes HISTORICAL_IMPORT.
      this.prisma.serviceVisit.count({
        where: {
          siteId,
          sourceType: 'APPOINTMENT',
          checkedInAt: { gte: start, lte: end },
        },
      }),

      // Walk-in count — explicit sourceType already excludes HISTORICAL_IMPORT.
      this.prisma.serviceVisit.count({
        where: {
          siteId,
          sourceType: 'WALKIN',
          checkedInAt: { gte: start, lte: end },
        },
      }),

      // Missed appointments — appointment table; the historical import created
      // no appointments, so no source filter is needed (exempt).
      this.prisma.appointment.count({
        where: {
          siteId,
          status: 'MISSED',
          scheduledStartAt: { gte: start, lte: end },
        },
      }),

      // Cancelled appointments — appointment table (exempt, see above).
      this.prisma.appointment.count({
        where: {
          siteId,
          status: 'CANCELLED',
          scheduledStartAt: { gte: start, lte: end },
        },
      }),

      // Override count — audit_logs; no historical-import rows (exempt).
      this.prisma.auditLog.count({
        where: {
          action: 'QUEUE_OVERRIDE_APPLIED',
          createdAt: { gte: start, lte: end },
        },
      }),

      // Average wait time (minutes from check-in to now for closed visits,
      // or just from check-in for all visits in period)
      this.prisma.$queryRaw<Array<{ avg_wait: number | null }>>`
        SELECT AVG(
          EXTRACT(EPOCH FROM (
            COALESCE(
              (SELECT MIN(sh.changed_at) FROM status_history sh
               WHERE sh.entity_type = 'ServiceVisit'
               AND sh.entity_id = sv.id
               AND sh.to_status IN ('QUEUED', 'CALLED', 'IN_SERVICE')),
              NOW()
            ) - sv.checked_in_at
          )) / 60
        )::numeric(10,1) as avg_wait
        FROM service_visits sv
        WHERE sv.site_id = ${siteId}::uuid
        AND sv.checked_in_at >= ${start}
        AND sv.checked_in_at <= ${end}
        AND sv.checked_in_at IS NOT NULL
        ${liveVisitSql('sv', includeHistorical)}
      `,
    ]);

    const avgWait = avgWaitMinutes[0]?.avg_wait;

    return [
      {
        code: 'KPI-01',
        name: 'Total Check-Ins',
        value: totalCheckedIn,
        target: null,
      },
      {
        code: 'KPI-02',
        name: 'Appointments',
        value: appointmentCount,
        target: null,
      },
      {
        code: 'KPI-03',
        name: 'Walk-Ins',
        value: walkinCount,
        target: null,
      },
      {
        code: 'KPI-04',
        name: 'Appointment vs Walk-In Ratio',
        value:
          totalCheckedIn > 0
            ? `${Math.round((appointmentCount / totalCheckedIn) * 100)}%`
            : 'N/A',
        target: null,
      },
      {
        code: 'KPI-05',
        name: 'Average Wait Time (min)',
        value: avgWait != null ? Number(avgWait) : null,
        target: '< 40 min',
      },
      {
        code: 'KPI-06',
        name: 'Missed Appointments',
        value: missedCount,
        target: '< 8%',
      },
      {
        code: 'KPI-07',
        name: 'Cancelled Appointments',
        value: cancelledCount,
        target: null,
      },
      {
        code: 'KPI-08',
        name: 'No-Show Rate',
        value:
          appointmentCount + missedCount > 0
            ? `${Math.round((missedCount / (appointmentCount + missedCount)) * 100)}%`
            : 'N/A',
        target: '< 8%',
      },
      {
        code: 'KPI-09',
        name: 'Queue Overrides',
        value: overrideCount,
        target: null,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Phase 5 — Advanced Analytics
  // ---------------------------------------------------------------------------

  /**
   * Return daily data points for a given metric over a date range.
   * Supported metrics: check_ins, wait_time, no_shows, overrides.
   */
  async getTrendData(
    siteId: string,
    startDate: string,
    endDate: string,
    metric: TrendMetric,
    includeHistorical = false,
  ): Promise<TrendDataPoint[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    switch (metric) {
      case 'check_ins': {
        const rows = await this.prisma.$queryRaw<
          Array<{ day: Date; value: bigint }>
        >`
          SELECT DATE(sv.checked_in_at) AS day, COUNT(*)::bigint AS value
          FROM service_visits sv
          WHERE sv.site_id = ${siteId}::uuid
            AND sv.checked_in_at >= ${start}
            AND sv.checked_in_at <= ${end}
            AND sv.checked_in_at IS NOT NULL
            ${liveVisitSql('sv', includeHistorical)}
          GROUP BY DATE(sv.checked_in_at)
          ORDER BY day
        `;
        return rows.map((r) => ({
          date: r.day.toISOString().slice(0, 10),
          value: Number(r.value),
        }));
      }

      case 'wait_time': {
        const rows = await this.prisma.$queryRaw<
          Array<{ day: Date; value: number | null }>
        >`
          SELECT DATE(sv.checked_in_at) AS day,
            AVG(
              EXTRACT(EPOCH FROM (
                COALESCE(
                  (SELECT MIN(sh.changed_at) FROM status_history sh
                   WHERE sh.entity_type = 'ServiceVisit'
                     AND sh.entity_id = sv.id
                     AND sh.to_status IN ('QUEUED', 'CALLED', 'IN_SERVICE')),
                  NOW()
                ) - sv.checked_in_at
              )) / 60
            )::numeric(10,1) AS value
          FROM service_visits sv
          WHERE sv.site_id = ${siteId}::uuid
            AND sv.checked_in_at >= ${start}
            AND sv.checked_in_at <= ${end}
            AND sv.checked_in_at IS NOT NULL
            ${liveVisitSql('sv', includeHistorical)}
          GROUP BY DATE(sv.checked_in_at)
          ORDER BY day
        `;
        return rows.map((r) => ({
          date: r.day.toISOString().slice(0, 10),
          value: r.value != null ? Number(r.value) : 0,
        }));
      }

      // no_shows (appointments) and overrides (audit_logs) have no historical-import
      // rows, so they need no source filter (exempt).
      case 'no_shows': {
        const rows = await this.prisma.$queryRaw<
          Array<{ day: Date; value: bigint }>
        >`
          SELECT DATE(a.scheduled_start_at) AS day, COUNT(*)::bigint AS value
          FROM appointments a
          WHERE a.site_id = ${siteId}::uuid
            AND a.status = 'MISSED'
            AND a.scheduled_start_at >= ${start}
            AND a.scheduled_start_at <= ${end}
          GROUP BY DATE(a.scheduled_start_at)
          ORDER BY day
        `;
        return rows.map((r) => ({
          date: r.day.toISOString().slice(0, 10),
          value: Number(r.value),
        }));
      }

      case 'overrides': {
        const rows = await this.prisma.$queryRaw<
          Array<{ day: Date; value: bigint }>
        >`
          SELECT DATE(al.created_at) AS day, COUNT(*)::bigint AS value
          FROM audit_logs al
          WHERE al.action = 'QUEUE_OVERRIDE_APPLIED'
            AND al.created_at >= ${start}
            AND al.created_at <= ${end}
          GROUP BY DATE(al.created_at)
          ORDER BY day
        `;
        return rows.map((r) => ({
          date: r.day.toISOString().slice(0, 10),
          value: Number(r.value),
        }));
      }

      default:
        throw new BadRequestException(
          `Unknown trend metric: ${metric as string}. Supported: check_ins, wait_time, no_shows, overrides`,
        );
    }
  }

  /**
   * Technician utilisation for a site over a date range.
   * Uses 8 hours/day as default available capacity.
   */
  async getTechnicianUtilization(
    siteId: string,
    startDate: string,
    endDate: string,
    includeHistorical = false,
  ): Promise<TechnicianUtilizationRow[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // Calculate total working days in the range (Mon-Sat by convention, but
    // we use calendar days for simplicity — 8h per day).
    const msDiff = end.getTime() - start.getTime();
    const totalDays = Math.max(1, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));
    const availableMinutes = totalDays * 8 * 60;

    const rows = await this.prisma.$queryRaw<
      Array<{
        technician_id: string;
        employee_code: string;
        full_name: string;
        total_assignments: bigint;
        total_minutes_worked: number | null;
      }>
    >`
      SELECT
        t.id AS technician_id,
        t.employee_code,
        ua.full_name,
        COUNT(ta.id)::bigint AS total_assignments,
        COALESCE(
          SUM(EXTRACT(EPOCH FROM (ta.ended_at - ta.started_at)) / 60),
          0
        )::numeric(12,1) AS total_minutes_worked
      FROM technicians t
      INNER JOIN user_accounts ua ON ua.id = t.user_account_id
      LEFT JOIN technician_assignments ta
        ON ta.technician_id = t.id
        AND ta.started_at IS NOT NULL
        AND ta.ended_at IS NOT NULL
        AND ta.assigned_at >= ${start}
        AND ta.assigned_at <= ${end}
        AND ta.service_order_id IN (
          SELECT so.id FROM service_orders so
          INNER JOIN service_visits sv ON sv.id = so.service_visit_id
          WHERE true ${liveVisitSql('sv', includeHistorical)}
        )
      WHERE t.home_site_id = ${siteId}::uuid
        AND t.status = 'ACTIVE'
      GROUP BY t.id, t.employee_code, ua.full_name
      ORDER BY total_minutes_worked DESC
    `;

    return rows.map((r) => {
      const minutesWorked = Number(r.total_minutes_worked ?? 0);
      return {
        technicianId: r.technician_id,
        employeeCode: r.employee_code,
        fullName: r.full_name,
        totalAssignments: Number(r.total_assignments),
        totalMinutesWorked: minutesWorked,
        utilizationPercent:
          availableMinutes > 0
            ? Math.round((minutesWorked / availableMinutes) * 1000) / 10
            : 0,
      };
    });
  }

  /**
   * Count service orders by service type family.
   */
  async getServiceFamilyBreakdown(
    siteId: string,
    startDate: string,
    endDate: string,
    includeHistorical = false,
  ): Promise<ServiceFamilyBreakdownRow[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const rows = await this.prisma.$queryRaw<
      Array<{
        family: string;
        count: bigint;
        total_duration_minutes: number | null;
      }>
    >`
      SELECT
        st.family,
        COUNT(soi.id)::bigint AS count,
        COALESCE(SUM(COALESCE(soi.actual_minutes, soi.estimate_minutes, 0)), 0)::int AS total_duration_minutes
      FROM service_order_items soi
      INNER JOIN service_types st ON st.id = soi.service_type_id
      INNER JOIN service_orders so ON so.id = soi.service_order_id
      INNER JOIN service_visits sv ON sv.id = so.service_visit_id
      WHERE sv.site_id = ${siteId}::uuid
        AND so.created_at >= ${start}
        AND so.created_at <= ${end}
        ${liveVisitSql('sv', includeHistorical)}
      GROUP BY st.family
      ORDER BY count DESC
    `;

    return rows.map((r) => ({
      family: r.family,
      count: Number(r.count),
      totalDurationMinutes: Number(r.total_duration_minutes ?? 0),
    }));
  }

  /**
   * Maintenance retention analytics — overdue, upcoming, and total recommendations.
   */
  async getMaintenanceRetention(
    siteId: string,
    includeHistorical = false,
  ): Promise<MaintenanceRetentionResult> {
    const now = new Date();
    const upcomingThresholdMiles = 1000;
    const upcomingThresholdDays = 30;
    const upcomingDate = new Date(now);
    upcomingDate.setDate(upcomingDate.getDate() + upcomingThresholdDays);

    const [overdueResult, upcomingResult, totalResult] = await Promise.all([
      // Overdue: nextDueOdometer < vehicle.odometer OR nextDueDate < today
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT mr.id)::bigint AS count
        FROM maintenance_recommendations mr
        INNER JOIN vehicles v ON v.id = mr.vehicle_id
        INNER JOIN service_visits sv ON sv.id = mr.service_visit_id
        WHERE sv.site_id = ${siteId}::uuid
          AND mr.supersedes_recommendation_id IS NULL
          ${liveVisitSql('sv', includeHistorical)}
          AND (
            (mr.next_due_odometer IS NOT NULL AND v.odometer IS NOT NULL AND mr.next_due_odometer < v.odometer)
            OR
            (mr.next_due_date IS NOT NULL AND mr.next_due_date < ${now})
          )
      `,
      // Upcoming: within threshold but not yet overdue
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT mr.id)::bigint AS count
        FROM maintenance_recommendations mr
        INNER JOIN vehicles v ON v.id = mr.vehicle_id
        INNER JOIN service_visits sv ON sv.id = mr.service_visit_id
        WHERE sv.site_id = ${siteId}::uuid
          AND mr.supersedes_recommendation_id IS NULL
          ${liveVisitSql('sv', includeHistorical)}
          AND (
            (
              mr.next_due_odometer IS NOT NULL AND v.odometer IS NOT NULL
              AND mr.next_due_odometer >= v.odometer
              AND mr.next_due_odometer <= v.odometer + ${upcomingThresholdMiles}
            )
            OR
            (
              mr.next_due_date IS NOT NULL
              AND mr.next_due_date >= ${now}
              AND mr.next_due_date <= ${upcomingDate}
            )
          )
      `,
      // Total active recommendations
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT mr.id)::bigint AS count
        FROM maintenance_recommendations mr
        INNER JOIN service_visits sv ON sv.id = mr.service_visit_id
        WHERE sv.site_id = ${siteId}::uuid
          AND mr.supersedes_recommendation_id IS NULL
          ${liveVisitSql('sv', includeHistorical)}
      `,
    ]);

    const overdue = Number(overdueResult[0]?.count ?? 0);
    const upcoming = Number(upcomingResult[0]?.count ?? 0);
    const total = Number(totalResult[0]?.count ?? 0);

    return {
      overdue,
      upcoming,
      total,
      retentionOpportunities: overdue + upcoming,
    };
  }

  /**
   * Queue performance summary for a site over a date range.
   */
  async getQueuePerformanceSummary(
    siteId: string,
    startDate: string,
    endDate: string,
    includeHistorical = false,
  ): Promise<QueuePerformanceSummary> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const [rankChangesResult, avgScoreResult, overrideResult, totalVisitsResult] =
      await Promise.all([
        // Average number of QueueDecision snapshots per visit
        this.prisma.$queryRaw<Array<{ avg_rank_changes: number | null }>>`
          SELECT AVG(decision_count)::numeric(10,2) AS avg_rank_changes
          FROM (
            SELECT qd.service_visit_id, COUNT(qd.id) AS decision_count
            FROM queue_decisions qd
            INNER JOIN service_visits sv ON sv.id = qd.service_visit_id
            WHERE sv.site_id = ${siteId}::uuid
              AND sv.checked_in_at >= ${start}
              AND sv.checked_in_at <= ${end}
              ${liveVisitSql('sv', includeHistorical)}
            GROUP BY qd.service_visit_id
          ) sub
        `,

        // Average score when visit transitioned to IN_SERVICE
        this.prisma.$queryRaw<Array<{ avg_score: number | null }>>`
          SELECT AVG(qd.score)::numeric(10,2) AS avg_score
          FROM queue_decisions qd
          INNER JOIN service_visits sv ON sv.id = qd.service_visit_id
          WHERE sv.site_id = ${siteId}::uuid
            AND sv.checked_in_at >= ${start}
            AND sv.checked_in_at <= ${end}
            ${liveVisitSql('sv', includeHistorical)}
            AND qd.snapshot_at = (
              SELECT MAX(qd2.snapshot_at)
              FROM queue_decisions qd2
              WHERE qd2.service_visit_id = qd.service_visit_id
                AND qd2.snapshot_at <= COALESCE(
                  (SELECT MIN(sh.changed_at) FROM status_history sh
                   WHERE sh.entity_type = 'ServiceVisit'
                     AND sh.entity_id = sv.id
                     AND sh.to_status = 'IN_SERVICE'),
                  qd2.snapshot_at
                )
            )
        `,

        // Override count
        this.prisma.auditLog.count({
          where: {
            action: 'QUEUE_OVERRIDE_APPLIED',
            createdAt: { gte: start, lte: end },
          },
        }),

        // Total visits in period (excludes HISTORICAL_IMPORT by default)
        this.prisma.serviceVisit.count({
          where: {
            siteId,
            checkedInAt: { gte: start, lte: end },
            ...liveVisitWhere(includeHistorical),
          },
        }),
      ]);

    const avgRankChanges = Number(rankChangesResult[0]?.avg_rank_changes ?? 0);
    const avgScoreAtService =
      avgScoreResult[0]?.avg_score != null
        ? Number(avgScoreResult[0].avg_score)
        : null;
    const totalOverrides = overrideResult;
    const totalVisits = totalVisitsResult;
    const overrideRate =
      totalVisits > 0
        ? Math.round((totalOverrides / totalVisits) * 1000) / 10
        : 0;

    return {
      avgRankChanges,
      avgScoreAtService,
      overrideRate,
      totalVisits,
      totalOverrides,
    };
  }

  /**
   * CR-2026-013 — Historical analytics (read-only, HISTORICAL-ONLY).
   * Aggregates the imported historical jobs (sourceType = HISTORICAL_IMPORT) for
   * management insight; never touches live operational views. Optional date
   * window (defaults to the full historical span). Service-family mix is omitted
   * (the import stored no structured order-items); avg duration is reported with
   * its sample size (only a subset of orders has both start + end timestamps).
   */
  async getHistoricalAnalytics(opts: { from?: string; to?: string } = {}) {
    const from = opts.from ? new Date(opts.from) : null;
    const to = opts.to ? new Date(opts.to) : null;
    if (to) to.setHours(23, 59, 59, 999);
    const hist = historicalVisitWhere();
    const dateWhere =
      from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {};
    const fromSql = from ? Prisma.sql`AND sv.created_at >= ${from}` : Prisma.empty;
    const toSql = to ? Prisma.sql`AND sv.created_at <= ${to}` : Prisma.empty;

    const [span, statusRows, totalOrders, pausedRows, reworkedRows, monthlyRows, techRows, durRows] =
      await Promise.all([
        this.prisma.serviceVisit.aggregate({
          _min: { createdAt: true },
          _max: { createdAt: true },
          where: hist,
        }),
        this.prisma.serviceVisit.groupBy({
          by: ['status'],
          where: { ...hist, ...dateWhere },
          _count: { _all: true },
        }),
        this.prisma.serviceOrder.count({ where: { serviceVisit: { ...hist, ...dateWhere } } }),
        this.prisma.serviceOrderPause.findMany({
          where: { serviceOrder: { serviceVisit: { ...hist, ...dateWhere } } },
          select: { serviceOrderId: true },
          distinct: ['serviceOrderId'],
        }),
        this.prisma.serviceOrderRework.findMany({
          where: { serviceOrder: { serviceVisit: { ...hist, ...dateWhere } } },
          select: { serviceOrderId: true },
          distinct: ['serviceOrderId'],
        }),
        this.prisma.$queryRaw<Array<{ month: Date; jobs: number }>>`
          SELECT date_trunc('month', sv.created_at) AS month, COUNT(*)::int AS jobs
          FROM service_visits sv
          WHERE true ${historicalVisitSql('sv')} ${fromSql} ${toSql}
          GROUP BY 1 ORDER BY 1`,
        this.prisma.$queryRaw<Array<{ technicianId: string; name: string; jobs: number }>>`
          SELECT t.id AS "technicianId", ua.full_name AS name, COUNT(*)::int AS jobs
          FROM technician_assignments ta
          INNER JOIN service_orders so ON so.id = ta.service_order_id
          INNER JOIN service_visits sv ON sv.id = so.service_visit_id
          INNER JOIN technicians t ON t.id = ta.technician_id
          INNER JOIN user_accounts ua ON ua.id = t.user_account_id
          WHERE true ${historicalVisitSql('sv')} ${fromSql} ${toSql}
          GROUP BY t.id, ua.full_name ORDER BY jobs DESC LIMIT 15`,
        this.prisma.$queryRaw<Array<{ avg_minutes: number | null; sample: number }>>`
          SELECT AVG(EXTRACT(EPOCH FROM (so.completed_at - so.started_at)) / 60)::int AS avg_minutes,
                 COUNT(*)::int AS sample
          FROM service_orders so
          INNER JOIN service_visits sv ON sv.id = so.service_visit_id
          WHERE so.started_at IS NOT NULL AND so.completed_at IS NOT NULL
            AND so.completed_at > so.started_at
            ${historicalVisitSql('sv')} ${fromSql} ${toSql}`,
      ]);

    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r._count._all;
    const totalJobs = statusRows.reduce((s, r) => s + r._count._all, 0);
    const completed = byStatus['CLOSED'] ?? 0; // historical terminal completed → CLOSED
    const cancelled = byStatus['CANCELLED'] ?? 0;
    const other = totalJobs - completed - cancelled;
    const pct = (n: number) => (totalJobs > 0 ? Math.round((n / totalJobs) * 1000) / 10 : 0);
    const rate = (n: number) => (totalOrders > 0 ? Math.round((n / totalOrders) * 1000) / 10 : 0);

    return {
      span: {
        from: span._min.createdAt ? span._min.createdAt.toISOString().slice(0, 10) : null,
        to: span._max.createdAt ? span._max.createdAt.toISOString().slice(0, 10) : null,
      },
      headline: {
        totalJobs,
        completed,
        cancelled,
        other,
        completionRate: pct(completed),
        cancellationRate: pct(cancelled),
      },
      totalOrders,
      pauseRate: rate(pausedRows.length),
      reworkRate: rate(reworkedRows.length),
      avgDurationMinutes: durRows[0]?.avg_minutes != null ? Number(durRows[0].avg_minutes) : null,
      durationSampleSize: durRows[0] ? Number(durRows[0].sample) : 0,
      monthlyVolume: monthlyRows.map((r) => ({
        month: new Date(r.month).toISOString().slice(0, 7),
        jobs: Number(r.jobs),
      })),
      byTechnician: techRows.map((r) => ({
        technicianId: r.technicianId,
        name: r.name,
        jobs: Number(r.jobs),
      })),
    };
  }

  /**
   * CR-2026-031 — Rework / First-Time-Fix report (LIVE operational).
   *
   * Surfaces jobs that "came back" — i.e. ServiceOrders with one or more
   * ServiceOrderRework records — over LIVE service orders (excludes
   * HISTORICAL_IMPORT + test-data via liveVisitWhere). Reports:
   *   - reworkRate       = distinct reworked orders / total orders
   *   - firstTimeFixRate = 100 - reworkRate
   * plus the rework ledger (reason, count, original order, customer, vehicle,
   * primary technician). Optional site + date window. No rule/engine change.
   */
  async getReworkReport(opts: { siteId?: string; from?: string; to?: string } = {}) {
    const from = opts.from ? new Date(opts.from) : null;
    const to = opts.to ? new Date(opts.to) : null;
    if (to) to.setHours(23, 59, 59, 999);
    const dateWhere: Prisma.ServiceVisitWhereInput =
      from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    const visitWhere: Prisma.ServiceVisitWhereInput = {
      ...liveVisitWhere(),
      ...dateWhere,
      ...(opts.siteId ? { siteId: opts.siteId } : {}),
    };
    const orderVisit: Prisma.ServiceOrderWhereInput = { serviceVisit: visitWhere };

    const [totalOrders, reworkedDistinct, reworks] = await Promise.all([
      this.prisma.serviceOrder.count({ where: orderVisit }),
      this.prisma.serviceOrderRework.findMany({
        where: { serviceOrder: orderVisit },
        select: { serviceOrderId: true },
        distinct: ['serviceOrderId'],
      }),
      this.prisma.serviceOrderRework.findMany({
        where: { serviceOrder: orderVisit },
        orderBy: { openedAt: 'desc' },
        take: 200,
        include: {
          serviceOrder: {
            select: {
              id: true,
              serviceVisit: {
                select: {
                  customer: { select: { firstName: true, lastName: true } },
                  vehicle: { select: { plateNumber: true } },
                },
              },
              assignments: {
                where: { isPrimary: true },
                select: { technician: { select: { userAccount: { select: { fullName: true } } } } },
              },
            },
          },
        },
      }),
    ]);

    const reworkedOrders = reworkedDistinct.length;
    const reworkRate = totalOrders > 0 ? Math.round((reworkedOrders / totalOrders) * 1000) / 10 : 0;
    const firstTimeFixRate = totalOrders > 0 ? Math.round((100 - reworkRate) * 10) / 10 : 0;

    const items = reworks.map((rw) => {
      const visit = rw.serviceOrder?.serviceVisit;
      const primaryTech = rw.serviceOrder?.assignments?.[0]?.technician?.userAccount?.fullName ?? null;
      return {
        id: rw.id,
        serviceOrderId: rw.serviceOrderId,
        reasonCode: rw.reasonCode,
        description: rw.description,
        reworkCount: rw.reworkCount,
        openedAt: rw.openedAt.toISOString(),
        closedAt: rw.closedAt ? rw.closedAt.toISOString() : null,
        customerName: visit?.customer ? `${visit.customer.firstName} ${visit.customer.lastName}` : '',
        vehiclePlate: visit?.vehicle?.plateNumber ?? '',
        primaryTechnician: primaryTech,
      };
    });

    return {
      summary: { totalOrders, reworkedOrders, reworkRate, firstTimeFixRate },
      items,
    };
  }

  /**
   * CR-2026-019 (P1c) — Service Mix / Job-Category analytics. READ-ONLY.
   * Built on ServiceJobMapping (historical) + ServiceCatalogItem (catalog/estimated
   * prices) + ServiceType.family (live). Never writes. No customer PII (categories,
   * service names, prices, technician names only). Estimated value = AUTO_MATCHED ×
   * catalog price only (never fuzzy, never invoice). mode='suggested' adds
   * NEEDS_REVIEW to VOLUME signal only (labelled low-confidence); revenue stays auto.
   */
  async getServiceMix(opts: { from?: string; to?: string; category?: string; mode?: 'auto' | 'suggested' } = {}) {
    const from = opts.from ? new Date(opts.from) : null;
    const to = opts.to ? new Date(opts.to) : null;
    if (to) to.setHours(23, 59, 59, 999);
    const mode = opts.mode === 'suggested' ? 'suggested' : 'auto';
    const fromSql = from ? Prisma.sql`AND sv.created_at >= ${from}` : Prisma.empty;
    const toSql = to ? Prisma.sql`AND sv.created_at <= ${to}` : Prisma.empty;
    const catSql = opts.category ? Prisma.sql`AND ci.category = ${opts.category}` : Prisma.empty;
    const modeSql = Prisma.raw(mode === 'suggested' ? `AND m.status IN ('AUTO_MATCHED','NEEDS_REVIEW')` : `AND m.status IN ('AUTO_MATCHED')`);
    const bothSql = Prisma.raw(`AND m.status IN ('AUTO_MATCHED','NEEDS_REVIEW')`);
    const hist = historicalVisitWhere();
    const dateWhere = from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};

    const [perJob, timeline, opRows, techRows, coverage, totalHistoricalOrders, live, span] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name: string; category: string; base_price: number | null; auto_vol: number; review_vol: number }>>`
        SELECT ci.id, ci.name, ci.category, ci.base_price::float8 AS base_price,
               COUNT(*) FILTER (WHERE m.status = 'AUTO_MATCHED')::int AS auto_vol,
               COUNT(*) FILTER (WHERE m.status = 'NEEDS_REVIEW')::int AS review_vol
        FROM service_job_mappings m
        JOIN service_catalog_items ci ON ci.id = m.catalog_item_id
        JOIN service_orders so ON so.id = m.service_order_id
        JOIN service_visits sv ON sv.id = so.service_visit_id
        WHERE true ${bothSql} ${historicalVisitSql('sv')} ${fromSql} ${toSql} ${catSql}
        GROUP BY ci.id, ci.name, ci.category, ci.base_price`,
      this.prisma.$queryRaw<Array<{ month: Date; category: string; jobs: number }>>`
        SELECT date_trunc('month', sv.created_at) AS month, ci.category, COUNT(*)::int AS jobs
        FROM service_job_mappings m
        JOIN service_catalog_items ci ON ci.id = m.catalog_item_id
        JOIN service_orders so ON so.id = m.service_order_id
        JOIN service_visits sv ON sv.id = so.service_visit_id
        WHERE true ${modeSql} ${historicalVisitSql('sv')} ${fromSql} ${toSql} ${catSql}
        GROUP BY 1, 2 ORDER BY 1`,
      this.prisma.$queryRaw<Array<{ category: string; orders: number; avg_minutes: number | null; dur_sample: number; completed: number; cancelled: number; paused: number; reworked: number }>>`
        WITH oc AS (
          SELECT DISTINCT so.id AS order_id, ci.category, so.started_at, so.completed_at, sv.status AS visit_status
          FROM service_job_mappings m
          JOIN service_catalog_items ci ON ci.id = m.catalog_item_id
          JOIN service_orders so ON so.id = m.service_order_id
          JOIN service_visits sv ON sv.id = so.service_visit_id
          WHERE true ${modeSql} ${historicalVisitSql('sv')} ${fromSql} ${toSql} ${catSql}
        )
        SELECT category, COUNT(*)::int AS orders,
          AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL AND completed_at > started_at)::int AS avg_minutes,
          COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL AND completed_at > started_at)::int AS dur_sample,
          COUNT(*) FILTER (WHERE visit_status = 'CLOSED')::int AS completed,
          COUNT(*) FILTER (WHERE visit_status = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE order_id IN (SELECT service_order_id FROM service_order_pauses))::int AS paused,
          COUNT(*) FILTER (WHERE order_id IN (SELECT service_order_id FROM service_order_reworks))::int AS reworked
        FROM oc GROUP BY category ORDER BY orders DESC`,
      this.prisma.$queryRaw<Array<{ category: string; name: string; jobs: number }>>`
        SELECT ci.category, ua.full_name AS name, COUNT(DISTINCT so.id)::int AS jobs
        FROM service_job_mappings m
        JOIN service_catalog_items ci ON ci.id = m.catalog_item_id
        JOIN service_orders so ON so.id = m.service_order_id
        JOIN service_visits sv ON sv.id = so.service_visit_id
        JOIN technician_assignments ta ON ta.service_order_id = so.id
        JOIN technicians t ON t.id = ta.technician_id
        JOIN user_accounts ua ON ua.id = t.user_account_id
        WHERE true ${modeSql} ${historicalVisitSql('sv')} ${fromSql} ${toSql} ${catSql}
        GROUP BY ci.category, ua.full_name ORDER BY jobs DESC LIMIT 80`,
      this.prisma.$queryRaw<Array<{ auto_orders: number; any_orders: number }>>`
        SELECT COUNT(DISTINCT m.service_order_id) FILTER (WHERE m.status = 'AUTO_MATCHED')::int AS auto_orders,
               COUNT(DISTINCT m.service_order_id)::int AS any_orders
        FROM service_job_mappings m
        JOIN service_orders so ON so.id = m.service_order_id
        JOIN service_visits sv ON sv.id = so.service_visit_id
        WHERE true ${bothSql} ${historicalVisitSql('sv')} ${fromSql} ${toSql}`,
      this.prisma.serviceOrder.count({ where: { serviceVisit: { ...hist, ...dateWhere } } }),
      this.prisma.$queryRaw<Array<{ category: string; items: number }>>`
        SELECT st.family AS category, COUNT(*)::int AS items
        FROM service_order_items soi
        JOIN service_orders so ON so.id = soi.service_order_id
        JOIN service_visits sv ON sv.id = so.service_visit_id
        JOIN service_types st ON st.id = soi.service_type_id
        WHERE true ${liveVisitSql('sv')}
        GROUP BY st.family ORDER BY items DESC`,
      this.prisma.serviceVisit.aggregate({ _min: { createdAt: true }, _max: { createdAt: true }, where: hist }),
    ]);

    // --- per-job derivations (one query covers category summary + job-level) ---
    const jobs = perJob.map((r) => {
      const basePrice = r.base_price != null ? Number(r.base_price) : null;
      const autoVol = Number(r.auto_vol), reviewVol = Number(r.review_vol);
      const volume = mode === 'suggested' ? autoVol + reviewVol : autoVol;
      return { id: r.id, name: r.name, category: r.category, basePrice, autoVol, reviewVol, volume, estValue: basePrice != null ? +(basePrice * autoVol).toFixed(2) : null };
    });
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

    const catMap = new Map<string, { category: string; auto: number; review: number; estValueAuto: number; missingPriceMappings: number }>();
    for (const j of jobs) {
      const c = catMap.get(j.category) ?? { category: j.category, auto: 0, review: 0, estValueAuto: 0, missingPriceMappings: 0 };
      c.auto += j.autoVol; c.review += j.reviewVol;
      if (j.basePrice != null) c.estValueAuto += j.basePrice * j.autoVol; else c.missingPriceMappings += j.autoVol;
      catMap.set(j.category, c);
    }
    const categorySummary = [...catMap.values()]
      .map((c) => ({ ...c, jobs: mode === 'suggested' ? c.auto + c.review : c.auto, estValueAuto: +c.estValueAuto.toFixed(2) }))
      .sort((a, b) => b.jobs - a.jobs);

    const priced = jobs.filter((j) => j.basePrice != null);
    const medPrice = median(priced.map((j) => j.basePrice as number));
    const medVol = median(priced.map((j) => j.volume));
    const slim = (j: typeof jobs[number]) => ({ name: j.name, category: j.category, volume: j.volume, basePrice: j.basePrice, estValue: j.estValue });

    const topByVolume = [...jobs].sort((a, b) => b.volume - a.volume).slice(0, 15).map(slim);
    const topByValue = priced.filter((j) => (j.estValue ?? 0) > 0).sort((a, b) => (b.estValue! - a.estValue!)).slice(0, 15).map(slim);
    const highVolumeLowValue = priced.filter((j) => (j.basePrice as number) <= medPrice).sort((a, b) => b.volume - a.volume).slice(0, 10).map(slim);
    const lowVolumeHighValue = priced.filter((j) => j.volume <= medVol).sort((a, b) => (b.basePrice as number) - (a.basePrice as number)).slice(0, 10).map(slim);
    const servicesMissingPrice = jobs.filter((j) => j.basePrice == null).sort((a, b) => b.volume - a.volume).slice(0, 15).map(slim);

    // --- timeline + growth/shrink + rolling 3-month ---
    const months = [...new Set(timeline.map((r) => new Date(r.month).toISOString().slice(0, 7)))].sort();
    const monthlyByCategory = timeline.map((r) => ({ month: new Date(r.month).toISOString().slice(0, 7), category: r.category, jobs: Number(r.jobs) }));
    const overallByMonth = months.map((m) => ({ month: m, jobs: monthlyByCategory.filter((r) => r.month === m).reduce((s, r) => s + r.jobs, 0) }));
    const overallMonthly = overallByMonth.map((p, i) => {
      const w = overallByMonth.slice(Math.max(0, i - 2), i + 1);
      return { month: p.month, jobs: p.jobs, rolling3: +(w.reduce((s, x) => s + x.jobs, 0) / w.length).toFixed(1) };
    });
    const recent = new Set(months.slice(-3)), prior = new Set(months.slice(-6, -3));
    const growthByCategory = new Map<string, { recent: number; prior: number }>();
    for (const r of monthlyByCategory) {
      const g = growthByCategory.get(r.category) ?? { recent: 0, prior: 0 };
      if (recent.has(r.month)) g.recent += r.jobs; else if (prior.has(r.month)) g.prior += r.jobs;
      growthByCategory.set(r.category, g);
    }
    const growth = [...growthByCategory.entries()].map(([category, g]) => ({ category, recent: g.recent, prior: g.prior, delta: g.recent - g.prior }));
    const topGrowing = [...growth].filter((g) => g.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 8);
    const topShrinking = [...growth].filter((g) => g.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 8);

    // --- operational by category ---
    const operationalByCategory = opRows.map((r) => ({
      category: r.category, orders: Number(r.orders),
      avgDurationMinutes: r.avg_minutes != null ? Number(r.avg_minutes) : null, durationSampleSize: Number(r.dur_sample),
      completed: Number(r.completed), cancelled: Number(r.cancelled),
      pauseRate: r.orders ? round1((100 * Number(r.paused)) / Number(r.orders)) : 0,
      reworkRate: r.orders ? round1((100 * Number(r.reworked)) / Number(r.orders)) : 0,
    }));

    // --- technician workload mix: top 3 per category ---
    const techByCat = new Map<string, Array<{ name: string; jobs: number }>>();
    for (const r of techRows) { (techByCat.get(r.category) ?? techByCat.set(r.category, []).get(r.category)!).push({ name: r.name, jobs: Number(r.jobs) }); }
    const technicianMixByCategory = [...techByCat.entries()].map(([category, list]) => ({ category, technicians: list.sort((a, b) => b.jobs - a.jobs).slice(0, 3) }));

    // --- coverage / review ---
    const autoOrders = Number(coverage[0]?.auto_orders ?? 0);
    const anyOrders = Number(coverage[0]?.any_orders ?? 0);
    const total = Number(totalHistoricalOrders);
    const reviewMappings = jobs.reduce((s, j) => s + j.reviewVol, 0);
    const autoMappings = jobs.reduce((s, j) => s + j.autoVol, 0);

    return {
      mode,
      span: {
        from: span._min.createdAt ? span._min.createdAt.toISOString().slice(0, 10) : null,
        to: span._max.createdAt ? span._max.createdAt.toISOString().slice(0, 10) : null,
      },
      valueNote: 'Estimated catalog value only (AUTO_MATCHED × catalog price). Not invoice revenue.',
      historical: {
        categorySummary,
        timeline: { months, monthlyByCategory, overallMonthly, topGrowing, topShrinking },
        jobs: { topByVolume, topByValue, highVolumeLowValue, lowVolumeHighValue, servicesMissingPrice },
        operationalByCategory,
        technicianMixByCategory,
        coverage: {
          totalHistoricalOrders: total,
          autoMappedOrders: autoOrders,
          anyMappedOrders: anyOrders,
          unmappedOrders: Math.max(0, total - anyOrders),
          analyticsReadyPct: total ? round1((100 * autoOrders) / total) : 0,
          potentialAfterReviewPct: total ? round1((100 * anyOrders) / total) : 0,
          unmappedPct: total ? round1((100 * (total - anyOrders)) / total) : 0,
          autoMappings, suggestedReviewMappings: reviewMappings,
          reviewBacklogByCategory: categorySummary.map((c) => ({ category: c.category, review: c.review })).filter((c) => c.review > 0).sort((a, b) => b.review - a.review),
        },
      },
      live: { serviceMixByFamily: live.map((r) => ({ family: r.category, items: Number(r.items) })), hasLiveItems: live.length > 0 },
    };
  }
}
