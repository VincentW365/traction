/**
 * CR-2026-105c — Appointments & Bookings report (docs/120 §D4, AG-09 definitions).
 *
 * One server payload; screen, print and CSV render it. Definitions:
 *  - total             appointments whose scheduled start falls in the period (any status)
 *  - self-service      sourceChannel = CUSTOMER_SELF_SERVICE; staff = everything else
 *  - cancellation rate CANCELLED ÷ total
 *  - reschedule rate   appointments with ≥ 1 "→ RESCHEDULED" StatusHistory row ÷ total
 *  - no-show rate      MISSED ÷ (MISSED + checked in)      (KPI-08; MISSED now has a writer)
 *  - booking lead time scheduled start − created at, median / p90 (hours), non-cancelled
 *  - on-time start     first order started ≤ scheduled start + protected_window_late_min
 *  - utilisation       Σ planned minutes of live bookings ÷ (open minutes × capacity)
 *  - ETA variance      actual completion − last published estimate (minutes), median / p90 of |Δ|
 *  - planned variance  actual completion − (scheduled start + planned minutes)
 */

import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { localDayRange } from './date-range';
import { EtaService } from '../scheduling/eta/eta.service';
import { ETA_DEFAULTS } from '../scheduling/eta/eta.config';
import { addDaysToKey, dayWindow, loadOperatingHours, localDayKey } from '../../common/helpers/operating-hours';

const MS = 60_000;
const SELF_SERVICE = 'CUSTOMER_SELF_SERVICE';

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}
const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

@Injectable()
export class AppointmentsReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly eta?: EtaService,
  ) {}

  async getReport(siteId: string, startDate: string, endDate: string, userId?: string) {
    const { start, end } = localDayRange(startDate, endDate);
    const [site, appts, lateRule, hours, generatedBy] = await Promise.all([
      this.prisma.site.findUnique({ where: { id: siteId }, select: { name: true, timezone: true } }),
      this.prisma.appointment.findMany({
        where: { siteId, scheduledStartAt: { gte: start, lte: end } },
        include: {
          services: { include: { serviceType: { select: { name: true, baseDurationMinutes: true } } } },
          customer: { select: { customerNumber: true } },
          vehicle: { select: { plateNumber: true, serviceClass: true } },
          serviceVisit: {
            select: {
              checkedInAt: true,
              currentEtaCompleteAt: true,
              status: true,
              serviceOrders: { select: { startedAt: true, completedAt: true, status: true } },
            },
          },
        },
        orderBy: { scheduledStartAt: 'asc' },
      }),
      this.prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'protected_window_late_min', effectiveTo: null }, select: { valueJson: true } }),
      loadOperatingHours(this.prisma as never, siteId),
      userId ? this.prisma.userAccount.findUnique({ where: { id: userId }, select: { fullName: true } }) : Promise.resolve(null),
    ]);

    const etaRules = this.eta ? await this.eta.loadRules(siteId).catch(() => ETA_DEFAULTS) : ETA_DEFAULTS;
    const lateMin = typeof lateRule?.valueJson === 'number' ? lateRule.valueJson : 15;
    const tz = site?.timezone ?? 'America/Jamaica';

    const ids = appts.map((a) => a.id);
    const history = ids.length
      ? await this.prisma.statusHistory.findMany({
          where: { entityType: 'Appointment', entityId: { in: ids }, toStatus: { in: ['RESCHEDULED', 'CANCELLED'] } },
          select: { entityId: true, toStatus: true },
        })
      : [];
    const reschedulesById = new Map<string, number>();
    for (const h of history) {
      if (h.toStatus === 'RESCHEDULED') reschedulesById.set(h.entityId, (reschedulesById.get(h.entityId) ?? 0) + 1);
    }

    // ---- per-appointment rows --------------------------------------------------
    const rows = appts.map((a) => {
      const planned = a.scheduledEndAt
        ? Math.round((a.scheduledEndAt.getTime() - a.scheduledStartAt.getTime()) / MS)
        : etaRules.defaultDurationMinutes;
      const orders = a.serviceVisit?.serviceOrders ?? [];
      const workStartedAt = orders.map((o) => o.startedAt).filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
      const actualCompletionAt = orders.map((o) => o.completedAt).filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
      const estimatedCompletionAt = a.serviceVisit?.currentEtaCompleteAt ?? null;
      const onTime = workStartedAt ? workStartedAt.getTime() <= a.scheduledStartAt.getTime() + lateMin * MS : null;
      const varianceMinutes =
        actualCompletionAt && estimatedCompletionAt ? Math.round((actualCompletionAt.getTime() - estimatedCompletionAt.getTime()) / MS) : null;
      const plannedVarianceMinutes = actualCompletionAt
        ? Math.round((actualCompletionAt.getTime() - (a.scheduledStartAt.getTime() + planned * MS)) / MS)
        : null;
      return {
        id: a.id,
        appointmentNumber: a.appointmentNumber,
        day: localDayKey(a.scheduledStartAt, tz),
        scheduledStartAt: a.scheduledStartAt,
        createdAt: a.createdAt,
        leadHours: Math.round(((a.scheduledStartAt.getTime() - a.createdAt.getTime()) / 3_600_000) * 10) / 10,
        status: a.status,
        source: a.sourceChannel === SELF_SERVICE ? 'SELF_SERVICE' : 'STAFF',
        customerNumber: a.customer.customerNumber,
        plate: a.vehicle.plateNumber,
        vehicleClass: a.vehicle.serviceClass,
        services: a.services.map((s) => s.serviceType.name),
        plannedMinutes: planned,
        reschedules: reschedulesById.get(a.id) ?? 0,
        checkedInAt: a.serviceVisit?.checkedInAt ?? null,
        workStartedAt,
        onTime,
        estimatedCompletionAt,
        actualCompletionAt,
        varianceMinutes,
        plannedVarianceMinutes,
      };
    });

    // ---- totals ----------------------------------------------------------------
    const total = rows.length;
    const selfService = rows.filter((r) => r.source === 'SELF_SERVICE').length;
    const cancelled = rows.filter((r) => r.status === 'CANCELLED').length;
    const rescheduled = rows.filter((r) => r.reschedules > 0).length;
    const missed = rows.filter((r) => r.status === 'MISSED').length;
    const checkedIn = rows.filter((r) => r.checkedInAt).length;
    const started = rows.filter((r) => r.onTime !== null);
    const onTime = started.filter((r) => r.onTime === true).length;
    const live = rows.filter((r) => r.status !== 'CANCELLED' && r.status !== 'MISSED');
    const leadHours = live.map((r) => r.leadHours);
    const variances = rows.map((r) => r.varianceMinutes).filter((v): v is number => v !== null);
    const plannedVariances = rows.map((r) => r.plannedVarianceMinutes).filter((v): v is number => v !== null);

    // capacity minutes per open day in the period
    const dayKeys: string[] = [];
    for (let k = startDate; k <= endDate; k = addDaysToKey(k, 1)) dayKeys.push(k);
    const capacityByDay = new Map<string, number>();
    for (const k of dayKeys) {
      const w = dayWindow(hours, k, tz);
      capacityByDay.set(k, w ? Math.round((w.close.getTime() - w.open.getTime()) / MS) * Math.max(1, etaRules.capacity) : 0);
    }
    const bookedMinutes = live.reduce((s, r) => s + r.plannedMinutes, 0);
    const capacityMinutes = [...capacityByDay.values()].reduce((s, v) => s + v, 0);

    const byDay = dayKeys.map((k) => {
      const d = rows.filter((r) => r.day === k);
      const dLive = d.filter((r) => r.status !== 'CANCELLED' && r.status !== 'MISSED');
      return {
        date: k,
        total: d.length,
        selfService: d.filter((r) => r.source === 'SELF_SERVICE').length,
        cancelled: d.filter((r) => r.status === 'CANCELLED').length,
        missed: d.filter((r) => r.status === 'MISSED').length,
        checkedIn: d.filter((r) => r.checkedInAt).length,
        bookedMinutes: dLive.reduce((s, r) => s + r.plannedMinutes, 0),
        capacityMinutes: capacityByDay.get(k) ?? 0,
      };
    });

    return {
      meta: {
        title: 'Appointments & Bookings Report',
        organisation: "Bert's Service Center",
        siteId,
        siteName: site?.name ?? null,
        period: { start: startDate, end: endDate, days: dayKeys.length },
        generatedAt: new Date(),
        generatedBy: generatedBy?.fullName ?? null,
        definitions: {
          onTimeStartLateMinutes: lateMin,
          capacity: etaRules.capacity,
          defaultDurationMinutes: etaRules.defaultDurationMinutes,
        },
      },
      hasData: total > 0,
      totals: {
        total,
        staffCreated: total - selfService,
        selfService,
        selfServiceRate: rate(selfService, total),
        cancelled,
        cancellationRate: rate(cancelled, total),
        rescheduled,
        rescheduleRate: rate(rescheduled, total),
        missed,
        checkedIn,
        noShowRate: rate(missed, missed + checkedIn),
        leadTimeMedianHours: percentile(leadHours, 50),
        leadTimeP90Hours: percentile(leadHours, 90),
        started: started.length,
        onTimeStarts: onTime,
        onTimeStartRate: rate(onTime, started.length),
        bookedMinutes,
        capacityMinutes,
        availableCapacityMinutes: Math.max(0, capacityMinutes - bookedMinutes),
        utilisationRate: rate(bookedMinutes, capacityMinutes),
        etaVariance: {
          count: variances.length,
          medianAbsMinutes: percentile(variances.map(Math.abs), 50),
          p90AbsMinutes: percentile(variances.map(Math.abs), 90),
          medianSignedMinutes: percentile(variances, 50),
        },
        plannedVariance: {
          count: plannedVariances.length,
          medianAbsMinutes: percentile(plannedVariances.map(Math.abs), 50),
          p90AbsMinutes: percentile(plannedVariances.map(Math.abs), 90),
        },
      },
      byDay,
      rows,
    };
  }
}
