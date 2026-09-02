import { Injectable } from '@nestjs/common';
import { localDayRange } from './date-range';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { liveVisitWhere } from '../../common/helpers/operational-scope';

/**
 * CR-2026-100 — the Job Times report: elapsed time vs technician work time,
 * with the hold breakdown that makes the difference explainable.
 *
 * Two different questions, two different numbers, one payload:
 *
 *  - ELAPSED — wall clock from work started to work completed, INCLUDING
 *    operational holds. "How long did the job take start to finish?"
 *  - TECHNICIAN WORK — the sum of actual labour intervals from the segment
 *    ledger, EXCLUDING waiting-for-parts / waiting-for-customer / paused time.
 *    "How much labour was actually spent?"
 *
 * Neither is derived by renaming the other: elapsed comes from the order's own
 * start/completion timestamps; work time comes from TechnicianWorkSegment rows.
 * Both are returned together with the waiting breakdown so the client (screen
 * AND print) always shows figures from the same calculation — there is no
 * second reporting path to disagree with.
 *
 * Double-counting guard (the §15 rule): a technician's intervals are MERGED
 * (union) before summing, per job and across jobs, so overlapping rows can
 * never produce more labour than wall-clock time. Two technicians genuinely
 * working at once IS two labour-hours per clock-hour — that is real and kept.
 */

interface Interval {
  start: number;
  end: number;
}

/** Union length of a set of intervals, in ms. Overlaps count once. */
export function mergedDurationMs(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const i of sorted) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else if (i.end > curEnd) {
      curEnd = i.end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export interface JobTimesFilters {
  technicianId?: string;
  vehicleClass?: string;
  sourceType?: string;
  serviceTypeId?: string;
}

@Injectable()
export class JobTimesService {
  constructor(private readonly prisma: PrismaService) {}

  async getJobTimes(
    siteId: string,
    startDate: string,
    endDate: string,
    filters: JobTimesFilters = {},
  ) {
    // CR-2026-100 — the operator's local calendar day, not a UTC/local mix.
    const { start, end } = localDayRange(startDate, endDate);
    const now = Date.now();

    const orders = await this.prisma.serviceOrder.findMany({
      where: {
        serviceVisit: {
          siteId,
          ...liveVisitWhere(false),
          ...(filters.vehicleClass ? { vehicle: { serviceClass: filters.vehicleClass as never } } : {}),
          ...(filters.sourceType ? { sourceType: filters.sourceType as never } : {}),
        },
        startedAt: { not: null, gte: start, lte: end },
        status: { not: 'CANCELLED' },
        ...(filters.technicianId
          ? { assignments: { some: { technicianId: filters.technicianId } } }
          : {}),
        ...(filters.serviceTypeId
          ? { items: { some: { serviceTypeId: filters.serviceTypeId } } }
          : {}),
      },
      include: {
        items: {
          select: {
            serviceType: { select: { id: true, code: true, name: true, baseDurationMinutes: true } },
          },
        },
        pauses: { select: { reasonCode: true, startedAt: true, endedAt: true } },
        assignments: {
          select: {
            technicianId: true,
            technician: {
              select: { employeeCode: true, userAccount: { select: { fullName: true } } },
            },
          },
        },
        serviceVisit: {
          select: {
            visitNumber: true,
            sourceType: true,
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true, serviceClass: true } },
            queueTicket: { select: { ticketNumber: true } },
          },
        },
      },
      orderBy: { startedAt: 'asc' },
    });

    const orderIds = orders.map((o) => o.id);
    const segments = orderIds.length
      ? await this.prisma.technicianWorkSegment.findMany({
          where: { serviceOrderId: { in: orderIds } },
          select: { serviceOrderId: true, technicianId: true, startedAt: true, endedAt: true },
        })
      : [];

    const segsByOrder = new Map<string, typeof segments>();
    for (const s of segments) {
      const list = segsByOrder.get(s.serviceOrderId) ?? [];
      list.push(s);
      segsByOrder.set(s.serviceOrderId, list);
    }

    // ---- per-job rows: both bases + the hold breakdown ----
    const jobs = orders.map((o) => {
      const v = o.serviceVisit;
      const elapsedMs = (o.completedAt?.getTime() ?? now) - o.startedAt!.getTime();

      // Per-technician merge first (one person cannot double-count themselves),
      // then sum across technicians (two people at once is genuinely 2× labour).
      const orderSegs = segsByOrder.get(o.id) ?? [];
      const byTech = new Map<string, Interval[]>();
      for (const s of orderSegs) {
        const list = byTech.get(s.technicianId) ?? [];
        list.push({ start: s.startedAt.getTime(), end: s.endedAt?.getTime() ?? now });
        byTech.set(s.technicianId, list);
      }
      let techWorkMs = 0;
      for (const intervals of byTech.values()) techWorkMs += mergedDurationMs(intervals);

      let waitingPartsMs = 0;
      let waitingCustomerMs = 0;
      let otherPausedMs = 0;
      for (const p of o.pauses) {
        const ms = (p.endedAt?.getTime() ?? now) - p.startedAt.getTime();
        if (p.reasonCode === 'WAITING_PARTS') waitingPartsMs += ms;
        else if (p.reasonCode === 'CUSTOMER_AUTHORIZATION') waitingCustomerMs += ms;
        else otherPausedMs += ms;
      }

      return {
        orderId: o.id,
        status: o.status,
        // CR-2026-104 — distinct-visit counting ("one car, many jobs" must never
        // inflate vehicle counts) and booked-time targets ride the row.
        serviceVisitId: o.serviceVisitId,
        expectedMinutes: o.items.reduce(
          (sum, i) => sum + (i.serviceType.baseDurationMinutes ?? 0),
          0,
        ),
        serviceCodes: o.items.map((i) => i.serviceType.code),
        ticketNumber: v.queueTicket?.ticketNumber ?? null,
        visitNumber: v.visitNumber ?? null,
        customerName: `${v.customer.firstName} ${v.customer.lastName}`,
        plate: v.vehicle.plateNumber,
        vehicleClass: v.vehicle.serviceClass ?? null,
        sourceType: v.sourceType,
        services: o.items.map((i) => i.serviceType.name),
        technicians: o.assignments.map((a) => ({
          technicianId: a.technicianId,
          name: a.technician.userAccount?.fullName ?? a.technician.employeeCode,
        })),
        startedAt: o.startedAt,
        completedAt: o.completedAt,
        elapsedMs,
        techWorkMs,
        waitingPartsMs,
        waitingCustomerMs,
        otherPausedMs,
      };
    });

    // ---- per-technician aggregates (the §15 fields) ----
    const techAgg = new Map<
      string,
      {
        technicianId: string;
        name: string;
        employeeCode: string;
        orderIds: Set<string>;
        completedOrderIds: Set<string>;
        intervals: Interval[];
        heldMs: number;
        elapsedMs: number;
      }
    >();
    for (const o of orders) {
      const jobRow = jobs.find((j) => j.orderId === o.id)!;
      const heldMs = jobRow.waitingPartsMs + jobRow.waitingCustomerMs + jobRow.otherPausedMs;
      for (const a of o.assignments) {
        let agg = techAgg.get(a.technicianId);
        if (!agg) {
          agg = {
            technicianId: a.technicianId,
            name: a.technician.userAccount?.fullName ?? a.technician.employeeCode,
            employeeCode: a.technician.employeeCode,
            orderIds: new Set(),
            completedOrderIds: new Set(),
            intervals: [],
            heldMs: 0,
            elapsedMs: 0,
          };
          techAgg.set(a.technicianId, agg);
        }
        if (!agg.orderIds.has(o.id)) {
          agg.orderIds.add(o.id);
          if (o.completedAt) agg.completedOrderIds.add(o.id);
          agg.heldMs += heldMs;
          agg.elapsedMs += jobRow.elapsedMs;
        }
      }
    }
    // Productive time: the union of the technician's segments ACROSS all their
    // jobs in the range — physically bounded by the clock, never assignment math.
    for (const s of segments) {
      const agg = techAgg.get(s.technicianId);
      if (agg) {
        agg.intervals.push({ start: s.startedAt.getTime(), end: s.endedAt?.getTime() ?? now });
      }
    }
    const byTechnician = [...techAgg.values()]
      .map((a) => ({
        technicianId: a.technicianId,
        name: a.name,
        employeeCode: a.employeeCode,
        jobsAssigned: a.orderIds.size,
        jobsCompleted: a.completedOrderIds.size,
        productiveMs: mergedDurationMs(a.intervals),
        heldMs: a.heldMs,
        elapsedMs: a.elapsedMs,
      }))
      .sort((x, y) => y.productiveMs - x.productiveMs);

    // ---- summary ----
    const completed = jobs.filter((j) => j.completedAt);
    const sum = (arr: typeof jobs, f: (j: (typeof jobs)[number]) => number) =>
      arr.reduce((s, j) => s + f(j), 0);
    const summary = {
      jobsTotal: jobs.length,
      jobsCompleted: completed.length,
      jobsLive: jobs.length - completed.length,
      totalElapsedMs: sum(jobs, (j) => j.elapsedMs),
      totalTechWorkMs: sum(jobs, (j) => j.techWorkMs),
      totalWaitingPartsMs: sum(jobs, (j) => j.waitingPartsMs),
      totalWaitingCustomerMs: sum(jobs, (j) => j.waitingCustomerMs),
      totalOtherPausedMs: sum(jobs, (j) => j.otherPausedMs),
      avgElapsedMs: completed.length ? Math.round(sum(completed, (j) => j.elapsedMs) / completed.length) : 0,
      avgTechWorkMs: completed.length
        ? Math.round(sum(completed, (j) => j.techWorkMs) / completed.length)
        : 0,
    };

    return { jobs, byTechnician, summary };
  }
}
