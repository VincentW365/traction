import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ReportingService } from './reporting.service';
import { JobTimesService, JobTimesFilters } from './job-times.service';
import { localDayRange } from './date-range';
import { liveVisitWhere } from '../../common/helpers/operational-scope';

/**
 * CR-2026-104 — the Service Center Performance Report model.
 *
 * ONE shared reporting model (§25): this service COMPOSES the already-verified
 * calculation engines — `ReportingService.getKpis` (throughput + queue wait),
 * `JobTimesService.getJobTimes` (elapsed vs technician-work with the merged
 * labour ledger and the hold breakdown), `getReworkReport` (quality) — and
 * adds only visit-flow counts, trend bucketing and explicit-threshold
 * attention items. Screen, print and CSV all render THIS payload; there is no
 * second business-logic path to disagree with.
 *
 * Definitions (§26) the payload commits to:
 *  - Vehicles Serviced   = distinct visits among jobs STARTED in the period.
 *  - Jobs Completed      = those jobs with a completion (first submit to QC).
 *  - Elapsed Time        = startedAt → completedAt wall clock, holds included.
 *  - Technician Work     = union-merged labour segments (never > the clock).
 *  - Waiting for Parts / Customer = the measured pause-ledger intervals.
 *  - Rework Rate         = reworked orders ÷ orders in range (getReworkReport).
 */

export interface PerformanceReportFilters extends JobTimesFilters {}

const ATTENTION_THRESHOLDS = {
  /** A job whose elapsed time exceeds BOTH bounds is flagged. */
  longElapsedFactor: 2, // × booked time
  longElapsedMinMs: 3 * 3600_000, // and at least 3h
  /** A parts wait longer than this is flagged (matches the 4h ops alert). */
  longPartsWaitMs: 4 * 3600_000,
  /** A job reworked this many times or more is flagged. */
  repeatRework: 2,
} as const;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const avg = (values: number[]) =>
  values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
const max = (values: number[]) => (values.length ? Math.max(...values) : 0);

/** §20 — a comparison that refuses misleading percentages. */
function compare(value: number, prev: number | null) {
  if (prev === null) return { value, prev: null, diff: null, pct: null };
  const diff = value - prev;
  return {
    value,
    prev,
    diff,
    // No percentage against a zero base — the diff carries the story.
    pct: prev !== 0 ? Math.round((diff / prev) * 1000) / 10 : null,
  };
}

type JobRow = Awaited<ReturnType<JobTimesService['getJobTimes']>>['jobs'][number];

@Injectable()
export class PerformanceReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reporting: ReportingService,
    private readonly jobTimes: JobTimesService,
  ) {}

  async getReport(
    siteId: string,
    startDate: string,
    endDate: string,
    filters: PerformanceReportFilters = {},
    comparePrevious = false,
    generatedBy: string | null = null,
  ) {
    const { start, end } = localDayRange(startDate, endDate);

    // The footer names a person, not a UUID.
    const generatedByUser = generatedBy
      ? await this.prisma.userAccount.findUnique({
          where: { id: generatedBy },
          select: { fullName: true },
        })
      : null;

    // ---- the verified engines, current period ----
    const [kpis, jobTimes, rework] = await Promise.all([
      this.reporting.getKpis(siteId, startDate, endDate, false),
      this.jobTimes.getJobTimes(siteId, startDate, endDate, filters),
      this.reporting.getReworkReport({ siteId, from: startDate, to: endDate }),
    ]);
    const jobs = jobTimes.jobs as JobRow[];
    const kpi = (code: string): number => {
      const row = kpis.find((k: { code: string }) => k.code === code);
      const n = Number(row?.value);
      return Number.isFinite(n) ? n : 0;
    };

    // ---- previous period (§20): same length, immediately before ----
    const dayMs = 24 * 3600_000;
    const days = Math.round((end.getTime() - start.getTime() + 1) / dayMs);
    const prevEndDate = new Date(start.getTime() - dayMs);
    const prevStartDate = new Date(start.getTime() - days * dayMs);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let prev: { jobs: JobRow[]; kpi: (code: string) => number; reworkRate: number } | null = null;
    if (comparePrevious) {
      const [pk, pj, pr] = await Promise.all([
        this.reporting.getKpis(siteId, iso(prevStartDate), iso(prevEndDate), false),
        this.jobTimes.getJobTimes(siteId, iso(prevStartDate), iso(prevEndDate), filters),
        this.reporting.getReworkReport({ siteId, from: iso(prevStartDate), to: iso(prevEndDate) }),
      ]);
      prev = {
        jobs: pj.jobs as JobRow[],
        kpi: (code: string) => {
          const row = pk.find((k: { code: string }) => k.code === code);
          const n = Number(row?.value);
          return Number.isFinite(n) ? n : 0;
        },
        reworkRate: pr.summary.reworkRate,
      };
    }

    // ---- flow extras (visit-level, one pass) ----
    const visitScope = { siteId, ...liveVisitWhere(false) };
    const [closedVisits, readyVisits, cancelledVisits, currentlyWaitingParts, currentlyInRework] =
      await Promise.all([
        this.prisma.serviceVisit.count({
          where: { ...visitScope, checkedInAt: { gte: start, lte: end }, status: 'CLOSED' },
        }),
        this.prisma.serviceVisit.count({
          where: { ...visitScope, checkedInAt: { gte: start, lte: end }, status: 'READY_FOR_PICKUP' },
        }),
        this.prisma.serviceVisit.count({
          where: {
            ...visitScope,
            checkedInAt: { gte: start, lte: end },
            status: { in: ['CANCELLED', 'ABANDONED'] },
          },
        }),
        this.prisma.serviceOrderPause.count({
          where: {
            reasonCode: 'WAITING_PARTS',
            endedAt: null,
            serviceOrder: { serviceVisit: visitScope },
          },
        }),
        this.prisma.serviceOrderRework.count({
          where: { closedAt: null, serviceOrder: { serviceVisit: visitScope } },
        }),
      ]);

    // ---- derived sets ----
    const distinctVisits = (rows: JobRow[]) => new Set(rows.map((j) => j.serviceVisitId)).size;
    const completed = jobs.filter((j) => j.completedAt);
    const elapsedAll = jobs.map((j) => j.elapsedMs);
    const workAll = jobs.map((j) => j.techWorkMs);
    const elapsedDone = completed.map((j) => j.elapsedMs);
    const workDone = completed.map((j) => j.techWorkMs);
    const partsJobs = jobs.filter((j) => j.waitingPartsMs > 0);
    const customerJobs = jobs.filter((j) => j.waitingCustomerMs > 0);
    const otherPauseJobs = jobs.filter((j) => j.otherPausedMs > 0);
    const vehiclesServiced = distinctVisits(jobs);

    const prevVehicles = prev ? distinctVisits(prev.jobs) : null;
    const prevCompleted = prev ? prev.jobs.filter((j) => j.completedAt) : null;

    // ---- executive summary (§3) — both time bases always, never renamed ----
    const summary = {
      vehiclesServiced: compare(vehiclesServiced, prevVehicles),
      jobsStarted: compare(jobs.length, prev ? prev.jobs.length : null),
      jobsCompleted: compare(completed.length, prevCompleted ? prevCompleted.length : null),
      avgElapsedMs: compare(avg(elapsedDone), prevCompleted ? avg(prevCompleted.map((j) => j.elapsedMs)) : null),
      avgTechWorkMs: compare(avg(workDone), prevCompleted ? avg(prevCompleted.map((j) => j.techWorkMs)) : null),
      medianElapsedMs: median(elapsedDone),
      medianTechWorkMs: median(workDone),
      maxElapsedMs: max(elapsedAll),
      maxTechWorkMs: max(workAll),
      avgWaitMinutes: compare(kpi('KPI-05'), prev ? prev.kpi('KPI-05') : null),
      waitingPartsJobs: compare(partsJobs.length, prev ? prev.jobs.filter((j) => j.waitingPartsMs > 0).length : null),
      waitingPartsPct: vehiclesServiced > 0 ? Math.round((distinctVisits(partsJobs) / vehiclesServiced) * 1000) / 10 : 0,
      waitingCustomerJobs: customerJobs.length,
      reworkRate: compare(rework.summary.reworkRate, prev ? prev.reworkRate : null),
      appointments: compare(kpi('KPI-02'), prev ? prev.kpi('KPI-02') : null),
      walkIns: compare(kpi('KPI-03'), prev ? prev.kpi('KPI-03') : null),
    };

    // ---- operational flow (§7) ----
    const flow = {
      appointments: kpi('KPI-02'),
      walkIns: kpi('KPI-03'),
      totalArrivals: kpi('KPI-01'),
      jobsStarted: jobs.length,
      jobsCompleted: completed.length,
      visitsCompleted: closedVisits,
      readyForPickup: readyVisits,
      missedAppointments: kpi('KPI-06'),
      cancelledVisits,
    };

    // ---- appointment vs walk-in (§8) ----
    const bySource = (source: string) => {
      const rows = jobs.filter((j) => j.sourceType === source);
      const done = rows.filter((j) => j.completedAt);
      return {
        source,
        vehicles: distinctVisits(rows),
        jobs: rows.length,
        jobsCompleted: done.length,
        completionRate: rows.length ? Math.round((done.length / rows.length) * 1000) / 10 : 0,
        avgElapsedMs: avg(done.map((j) => j.elapsedMs)),
        avgTechWorkMs: avg(done.map((j) => j.techWorkMs)),
      };
    };
    const sourceComparison = {
      appointment: { ...bySource('APPOINTMENT'), noShowRate: kpi('KPI-08') },
      walkIn: bySource('WALKIN'),
    };

    // ---- vehicle types (§9) — unclassified shown, never silently dropped.
    // "Unclassified" = no class OR still marked UNKNOWN_REQUIRES_REVIEW, so the
    // three buckets PARTITION the job set (live-validation-pinned).
    const classBucket = (j: JobRow) =>
      j.vehicleClass === 'SEDAN_CLASS' || j.vehicleClass === 'SUV_CLASS'
        ? j.vehicleClass
        : 'UNCLASSIFIED';
    const byClass = (bucket: string) => {
      const rows = jobs.filter((j) => classBucket(j) === bucket);
      const done = rows.filter((j) => j.completedAt);
      return {
        vehicleClass: bucket,
        vehicles: distinctVisits(rows),
        jobs: rows.length,
        avgElapsedMs: avg(done.map((j) => j.elapsedMs)),
        avgTechWorkMs: avg(done.map((j) => j.techWorkMs)),
      };
    };
    const vehicleTypes = [byClass('SEDAN_CLASS'), byClass('SUV_CLASS'), byClass('UNCLASSIFIED')].filter(
      (r) => r.jobs > 0 || r.vehicleClass !== 'UNCLASSIFIED',
    );

    // ---- technician performance (§10/§11): the merged ledger + drill-down ----
    const reworkByPrimaryTech = new Map<string, number>();
    for (const item of rework.items as Array<{ primaryTechnician: string | null }>) {
      if (item.primaryTechnician) {
        reworkByPrimaryTech.set(
          item.primaryTechnician,
          (reworkByPrimaryTech.get(item.primaryTechnician) ?? 0) + 1,
        );
      }
    }
    const HELD = new Set(['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER']);
    const technicians = jobTimes.byTechnician.map((t) => {
      const theirJobs = jobs.filter((j) => j.technicians.some((x) => x.technicianId === t.technicianId));
      const completedTheirs = theirJobs.filter((j) => j.completedAt);
      return {
        technicianId: t.technicianId,
        name: t.name,
        employeeCode: t.employeeCode,
        jobsAssigned: t.jobsAssigned,
        jobsCompleted: t.jobsCompleted,
        productiveMs: t.productiveMs,
        avgWorkPerCompletedMs: completedTheirs.length
          ? Math.round(completedTheirs.reduce((s, j) => s + j.techWorkMs, 0) / completedTheirs.length)
          : 0,
        heldJobs: theirJobs.filter((j) => HELD.has(j.status)).length,
        reworkCount: reworkByPrimaryTech.get(t.name) ?? 0,
        // §11 — the numbers stay explainable: the jobs behind them.
        jobs: theirJobs.map((j) => ({
          orderId: j.orderId,
          plate: j.plate,
          visitNumber: j.visitNumber,
          serviceVisitId: j.serviceVisitId,
          services: j.services,
          status: j.status,
          elapsedMs: j.elapsedMs,
          techWorkMs: j.techWorkMs,
          waitingPartsMs: j.waitingPartsMs,
        })),
      };
    });

    // ---- delays (§12/§13) — operational delay, never technician time ----
    const delayRow = (type: string, rows: JobRow[], pick: (j: JobRow) => number) => {
      const values = rows.map(pick);
      return {
        type,
        jobsAffected: rows.length,
        totalMs: values.reduce((a, b) => a + b, 0),
        avgMs: avg(values),
        medianMs: median(values),
        maxMs: max(values),
      };
    };
    const delays = [
      delayRow('WAITING_PARTS', partsJobs, (j) => j.waitingPartsMs),
      delayRow('WAITING_CUSTOMER', customerJobs, (j) => j.waitingCustomerMs),
      delayRow('OTHER_PAUSED', otherPauseJobs, (j) => j.otherPausedMs),
    ];
    const parts = {
      ...delays[0],
      pctOfVehicles: summary.waitingPartsPct,
      currentlyWaiting: currentlyWaitingParts,
      jobs: partsJobs
        .map((j) => ({
          orderId: j.orderId,
          plate: j.plate,
          visitNumber: j.visitNumber,
          services: j.services,
          waitingPartsMs: j.waitingPartsMs,
          status: j.status,
        }))
        .sort((a, b) => b.waitingPartsMs - a.waitingPartsMs),
    };

    // ---- quality (§14) ----
    const quality = {
      jobsSentToQc: completed.length,
      reworkedOrders: rework.summary.reworkedOrders,
      reworkRate: rework.summary.reworkRate,
      firstTimeFixRate: rework.summary.firstTimeFixRate,
      eligibleOrders: rework.summary.totalOrders,
      currentlyInRework,
    };

    // ---- service types (§15/§16) — single-service jobs vs the booked target ----
    const svcMap = new Map<
      string,
      { code: string; name: string; targetMinutes: number; elapsed: number[]; work: number[] }
    >();
    let multiServiceJobs = 0;
    for (const j of completed) {
      if (j.serviceCodes.length !== 1) {
        if (j.serviceCodes.length > 1) multiServiceJobs++;
        continue;
      }
      const code = j.serviceCodes[0];
      let row = svcMap.get(code);
      if (!row) {
        row = { code, name: j.services[0], targetMinutes: j.expectedMinutes, elapsed: [], work: [] };
        svcMap.set(code, row);
      }
      row.elapsed.push(j.elapsedMs);
      row.work.push(j.techWorkMs);
    }
    const serviceTypes = {
      note: 'Single-service jobs only — a multi-service job cannot honestly split its time per service.',
      multiServiceJobs,
      rows: [...svcMap.values()]
        .map((r) => ({
          code: r.code,
          name: r.name,
          volume: r.elapsed.length,
          targetMinutes: r.targetMinutes,
          avgElapsedMs: avg(r.elapsed),
          avgTechWorkMs: avg(r.work),
          varianceElapsedMs: avg(r.elapsed) - r.targetMinutes * 60000,
          varianceTechWorkMs: avg(r.work) - r.targetMinutes * 60000,
        }))
        .sort((a, b) => b.volume - a.volume),
    };

    // ---- trend (§17): daily buckets from the same job rows ----
    const dayKey = (d: Date) => iso(d);
    const trendMap = new Map<string, { jobs: JobRow[]; arrivals: number }>();
    for (let t = start.getTime(); t <= end.getTime(); t += dayMs) {
      trendMap.set(dayKey(new Date(t)), { jobs: [], arrivals: 0 });
    }
    for (const j of jobs) {
      const key = dayKey(new Date(j.startedAt as unknown as string));
      trendMap.get(key)?.jobs.push(j);
    }
    const arrivalRows = await this.prisma.serviceVisit.findMany({
      where: { ...visitScope, checkedInAt: { gte: start, lte: end } },
      select: { checkedInAt: true },
    });
    for (const v of arrivalRows) {
      const key = dayKey(new Date(v.checkedInAt!));
      const bucket = trendMap.get(key);
      if (bucket) bucket.arrivals += 1;
    }
    const trend = [...trendMap.entries()].map(([date, b]) => {
      const done = b.jobs.filter((j) => j.completedAt);
      return {
        date,
        arrivals: b.arrivals,
        jobsStarted: b.jobs.length,
        jobsCompleted: done.length,
        avgElapsedMs: avg(done.map((j) => j.elapsedMs)),
        avgTechWorkMs: avg(done.map((j) => j.techWorkMs)),
        partsDelayMs: b.jobs.reduce((s, j) => s + j.waitingPartsMs, 0),
      };
    });

    // ---- attention (§18) — every threshold explicit in the payload ----
    const attention: Array<{ kind: string; threshold: string; label: string; detail: string; orderId?: string }> = [];
    for (const j of jobs) {
      const expectedMs = j.expectedMinutes * 60000;
      if (
        expectedMs > 0 &&
        j.elapsedMs >= expectedMs * ATTENTION_THRESHOLDS.longElapsedFactor &&
        j.elapsedMs >= ATTENTION_THRESHOLDS.longElapsedMinMs
      ) {
        attention.push({
          kind: 'LONG_ELAPSED',
          threshold: `> ${ATTENTION_THRESHOLDS.longElapsedFactor}× booked time and ≥ 3h`,
          label: `${j.plate} — elapsed far over booked time`,
          detail: `${j.services.join(', ')} · elapsed ${Math.round(j.elapsedMs / 60000)}m vs booked ${j.expectedMinutes}m`,
          orderId: j.orderId,
        });
      }
      if (j.waitingPartsMs >= ATTENTION_THRESHOLDS.longPartsWaitMs) {
        attention.push({
          kind: 'LONG_PARTS_WAIT',
          threshold: '≥ 4h waiting for parts',
          label: `${j.plate} — long parts wait`,
          detail: `${j.services.join(', ')} · ${Math.round(j.waitingPartsMs / 60000)}m waiting for parts`,
          orderId: j.orderId,
        });
      }
    }
    const repeatRework = (rework.items as Array<{ reworkCount: number; vehiclePlate: string; serviceOrderId: string; reasonCode: string }>).filter(
      (r) => r.reworkCount >= ATTENTION_THRESHOLDS.repeatRework,
    );
    for (const r of repeatRework) {
      attention.push({
        kind: 'REPEAT_REWORK',
        threshold: `≥ ${ATTENTION_THRESHOLDS.repeatRework} rework rounds`,
        label: `${r.vehiclePlate} — repeated rework`,
        detail: `${r.reasonCode} · came back ${r.reworkCount} times`,
        orderId: r.serviceOrderId,
      });
    }
    const unclassified = vehicleTypes.find((v) => v.vehicleClass === 'UNCLASSIFIED');
    if (unclassified && unclassified.jobs > 0) {
      attention.push({
        kind: 'UNCLASSIFIED_VEHICLES',
        threshold: 'any serviced vehicle without a Sedan/SUV class',
        label: `${unclassified.vehicles} vehicle(s) serviced without a classification`,
        detail: 'Their jobs cannot be benchmarked; classify them on the vehicle record.',
      });
    }

    return {
      meta: {
        title: "Service Center Performance Report",
        organisation: "Bert's Service Center",
        siteId,
        period: { start: startDate, end: endDate, days },
        comparePeriod: comparePrevious
          ? { start: iso(prevStartDate), end: iso(prevEndDate) }
          : null,
        generatedAt: new Date(),
        generatedBy: generatedByUser?.fullName ?? null,
        filters: {
          technicianId: filters.technicianId ?? null,
          vehicleClass: filters.vehicleClass ?? null,
          sourceType: filters.sourceType ?? null,
          serviceTypeId: filters.serviceTypeId ?? null,
        },
        thresholds: ATTENTION_THRESHOLDS,
      },
      summary,
      flow,
      sourceComparison,
      vehicleTypes,
      technicians,
      delays,
      parts,
      quality,
      serviceTypes,
      trend,
      attention,
      hasData: jobs.length > 0 || flow.totalArrivals > 0,
    };
  }
}
