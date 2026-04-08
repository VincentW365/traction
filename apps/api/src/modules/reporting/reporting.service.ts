import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

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
      // Total checked-in visits
      this.prisma.serviceVisit.count({
        where: {
          siteId,
          checkedInAt: { gte: start, lte: end },
        },
      }),

      // Appointment count
      this.prisma.serviceVisit.count({
        where: {
          siteId,
          sourceType: 'APPOINTMENT',
          checkedInAt: { gte: start, lte: end },
        },
      }),

      // Walk-in count
      this.prisma.serviceVisit.count({
        where: {
          siteId,
          sourceType: 'WALKIN',
          checkedInAt: { gte: start, lte: end },
        },
      }),

      // Missed appointments
      this.prisma.appointment.count({
        where: {
          siteId,
          status: 'MISSED',
          scheduledStartAt: { gte: start, lte: end },
        },
      }),

      // Cancelled appointments
      this.prisma.appointment.count({
        where: {
          siteId,
          status: 'CANCELLED',
          scheduledStartAt: { gte: start, lte: end },
        },
      }),

      // Override count
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
        name: 'Queue Overrides Today',
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
          GROUP BY DATE(sv.checked_in_at)
          ORDER BY day
        `;
        return rows.map((r) => ({
          date: r.day.toISOString().slice(0, 10),
          value: r.value != null ? Number(r.value) : 0,
        }));
      }

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

        // Total visits in period
        this.prisma.serviceVisit.count({
          where: {
            siteId,
            checkedInAt: { gte: start, lte: end },
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
}
