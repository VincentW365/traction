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

/* -------------------------------------------------------------------------
 * CR-2026-104b — the executive insight engine.
 *
 * Deterministic, factual, traceable: every insight is computed from the SAME
 * aggregates the KPI cards render, states WHAT changed and BY HOW MUCH, and
 * never speculates about why. Insights are ranked by BUSINESS SIGNIFICANCE —
 * magnitude × volume affected — not by percentage change, so a 100% jump from
 * 1 to 2 events never outranks a 20-minute shift across 40 vehicles. Small
 * samples are suppressed by explicit minimums, published in the payload.
 * ------------------------------------------------------------------------- */

export interface ExecInsight {
  id: string;
  tone: 'positive' | 'attention';
  title: string;
  /** The full factual sentence, value + comparison included. */
  detail: string;
  /** Business-significance score used for ranking (minutes-weighted). */
  significance: number;
  /** The numbers behind the sentence — traceable to the report dataset. */
  evidence: Record<string, number | string | null>;
}

export const INSIGHT_MINIMUMS = {
  /** Time-movement insights need at least this many completed jobs per period. */
  timeSampleJobs: 5,
  /** …and the average must move by ≥ this share and ≥ this many minutes. */
  timeMovePct: 10,
  timeMoveMinMs: 5 * 60000,
  /** Wait-time movement: minutes threshold. */
  waitMoveMinMinutes: 5,
  /** Rework movement: percentage points, with a minimum eligible base. */
  reworkMovePts: 2,
  reworkMinOrders: 10,
  /** Throughput movement: share and absolute floor. */
  throughputMovePct: 15,
  throughputMinVehicles: 5,
  /** Delay-frequency insights: minimum affected jobs (either period) or total delay. */
  delayMinJobs: 3,
  delayMinTotalMs: 2 * 3600_000,
  /** Source-gap insight: completed jobs per source and the gap share. */
  sourceMinJobs: 5,
  sourceGapPct: 25,
  /** Over-target service insight: volume, +share of target and absolute floor. */
  serviceMinVolume: 3,
  serviceOverPct: 25,
  serviceOverMinMs: 10 * 60000,
} as const;

function fmtDurS(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
const pctOf = (diff: number, base: number) => (base > 0 ? Math.round((Math.abs(diff) / base) * 100) : null);

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

    // ---- CR-2026-104b: executive insights — ranked by business significance ----
    const insights = this.buildInsights({
      summary,
      delays,
      sourceComparison,
      serviceRows: serviceTypes.rows,
      attentionCount: attention.length,
      hasCompare: comparePrevious,
    });

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
      insights,
      insightMinimums: INSIGHT_MINIMUMS,
      hasData: jobs.length > 0 || flow.totalArrivals > 0,
    };
  }

  /**
   * CR-2026-104b — build the ranked highlight/attention insights.
   *
   * Every candidate has an explicit data minimum; every emitted insight
   * carries its evidence. Significance ≈ minutes of impact × jobs affected,
   * never raw percentage change.
   */
  private buildInsights(input: {
    summary: {
      vehiclesServiced: { value: number; prev: number | null; diff: number | null };
      jobsCompleted: { value: number; prev: number | null };
      avgElapsedMs: { value: number; prev: number | null; diff: number | null };
      medianElapsedMs: number;
      avgWaitMinutes: { value: number; prev: number | null; diff: number | null };
      waitingPartsJobs: { value: number; prev: number | null };
      reworkRate: { value: number; prev: number | null; diff: number | null };
    };
    delays: Array<{ type: string; jobsAffected: number; totalMs: number; avgMs: number }>;
    sourceComparison: {
      appointment: { jobsCompleted: number; avgElapsedMs: number };
      walkIn: { jobsCompleted: number; avgElapsedMs: number };
    };
    serviceRows: Array<{ name: string; volume: number; targetMinutes: number; avgElapsedMs: number; varianceElapsedMs: number }>;
    attentionCount: number;
    hasCompare: boolean;
  }): { highlights: ExecInsight[]; attention: ExecInsight[] } {
    const M = INSIGHT_MINIMUMS;
    const s = input.summary;
    const out: ExecInsight[] = [];
    const sampleOk =
      s.jobsCompleted.value >= M.timeSampleJobs && (s.jobsCompleted.prev ?? 0) >= M.timeSampleJobs;

    // 1. Average service time movement (elapsed base; median quoted alongside).
    if (input.hasCompare && sampleOk && s.avgElapsedMs.prev != null && s.avgElapsedMs.diff != null) {
      const pct = pctOf(s.avgElapsedMs.diff, s.avgElapsedMs.prev);
      if (
        Math.abs(s.avgElapsedMs.diff) >= M.timeMoveMinMs &&
        pct != null &&
        pct >= M.timeMovePct
      ) {
        const improved = s.avgElapsedMs.diff < 0;
        out.push({
          id: 'SERVICE_TIME_MOVE',
          tone: improved ? 'positive' : 'attention',
          title: improved ? 'Improved Service Time' : 'Service Time Increased',
          detail:
            `Average elapsed service time ${improved ? 'decreased' : 'increased'} from ` +
            `${fmtDurS(s.avgElapsedMs.prev)} to ${fmtDurS(s.avgElapsedMs.value)}` +
            `${pct != null ? `, ${improved ? 'an' : 'a'} ${pct}% ${improved ? 'improvement' : 'increase'}` : ''} ` +
            `(median now ${fmtDurS(s.medianElapsedMs)}, across ${s.jobsCompleted.value} completed jobs).`,
          // minutes moved × jobs affected — volume-weighted, not percentage.
          significance: (Math.abs(s.avgElapsedMs.diff) / 60000) * s.jobsCompleted.value,
          evidence: {
            metric: 'avgElapsedMs',
            value: s.avgElapsedMs.value,
            prev: s.avgElapsedMs.prev,
            jobs: s.jobsCompleted.value,
          },
        });
      }
    }

    // 2. Queue wait movement.
    if (
      input.hasCompare &&
      s.avgWaitMinutes.prev != null &&
      s.avgWaitMinutes.diff != null &&
      Math.abs(s.avgWaitMinutes.diff) >= M.waitMoveMinMinutes &&
      s.vehiclesServiced.value >= M.timeSampleJobs
    ) {
      const improved = s.avgWaitMinutes.diff < 0;
      out.push({
        id: 'WAIT_TIME_MOVE',
        tone: improved ? 'positive' : 'attention',
        title: improved ? 'Customer Wait Reduced' : 'Customer Wait Increased',
        detail:
          `Average queue wait ${improved ? 'fell' : 'rose'} from ${fmtDurS(s.avgWaitMinutes.prev * 60000)} to ` +
          `${fmtDurS(s.avgWaitMinutes.value * 60000)}.`,
        significance: Math.abs(s.avgWaitMinutes.diff) * s.vehiclesServiced.value,
        evidence: { metric: 'avgWaitMinutes', value: s.avgWaitMinutes.value, prev: s.avgWaitMinutes.prev },
      });
    }

    // 3/4. Delay movement (parts and customer) — frequency AND duration.
    // Without comparison these still surface when the period itself is heavy.
    for (const [type, label] of [
      ['WAITING_PARTS', 'Waiting for Parts'],
      ['WAITING_CUSTOMER', 'Waiting for Customer'],
    ] as const) {
      const d = input.delays.find((x) => x.type === type);
      if (!d) continue;
      const heavy = d.jobsAffected >= M.delayMinJobs || d.totalMs >= M.delayMinTotalMs;
      if (!heavy) continue;
      if (type === 'WAITING_PARTS' && input.hasCompare && s.waitingPartsJobs.prev != null) {
        const diff = s.waitingPartsJobs.value - s.waitingPartsJobs.prev;
        if (diff !== 0) {
          const worse = diff > 0;
          out.push({
            id: 'PARTS_DELAY_MOVE',
            tone: worse ? 'attention' : 'positive',
            title: worse ? 'Parts Delays Increased' : 'Parts Delays Reduced',
            detail:
              `${s.waitingPartsJobs.value} job${s.waitingPartsJobs.value === 1 ? '' : 's'} experienced Waiting for Parts ` +
              `compared with ${s.waitingPartsJobs.prev} in the previous period. ` +
              `Total parts-related delay ${worse ? 'increased to' : 'was'} ${fmtDurS(d.totalMs)}.`,
            significance: d.totalMs / 60000 + Math.abs(diff) * 30,
            evidence: {
              metric: 'waitingPartsJobs',
              value: s.waitingPartsJobs.value,
              prev: s.waitingPartsJobs.prev,
              totalMs: d.totalMs,
            },
          });
          continue;
        }
      }
      // Within-period weight (no comparison, or unchanged frequency).
      out.push({
        id: `${type}_LOAD`,
        tone: 'attention',
        title: `${label} Load`,
        detail:
          `${d.jobsAffected} job${d.jobsAffected === 1 ? '' : 's'} recorded ${label.toLowerCase()} ` +
          `totalling ${fmtDurS(d.totalMs)} (average ${fmtDurS(d.avgMs)} per affected job).`,
        significance: d.totalMs / 60000,
        evidence: { metric: type, jobsAffected: d.jobsAffected, totalMs: d.totalMs },
      });
    }

    // 5. Rework movement.
    if (
      input.hasCompare &&
      s.reworkRate.prev != null &&
      s.reworkRate.diff != null &&
      Math.abs(s.reworkRate.diff) >= M.reworkMovePts &&
      s.jobsCompleted.value >= M.reworkMinOrders
    ) {
      const worse = s.reworkRate.diff > 0;
      out.push({
        id: 'REWORK_MOVE',
        tone: worse ? 'attention' : 'positive',
        title: worse ? 'Rework Increased' : 'Rework Reduced',
        detail: `Rework rate moved from ${s.reworkRate.prev}% to ${s.reworkRate.value}% of orders.`,
        significance: Math.abs(s.reworkRate.diff) * s.jobsCompleted.value,
        evidence: { metric: 'reworkRate', value: s.reworkRate.value, prev: s.reworkRate.prev },
      });
    }

    // 6. Throughput movement.
    if (input.hasCompare && s.vehiclesServiced.prev != null && s.vehiclesServiced.diff != null) {
      const pct = pctOf(s.vehiclesServiced.diff, s.vehiclesServiced.prev);
      if (
        Math.abs(s.vehiclesServiced.diff) >= M.throughputMinVehicles &&
        pct != null &&
        pct >= M.throughputMovePct
      ) {
        const up = s.vehiclesServiced.diff > 0;
        out.push({
          id: 'THROUGHPUT_MOVE',
          tone: up ? 'positive' : 'attention',
          title: up ? 'Throughput Increased' : 'Throughput Decreased',
          detail:
            `${s.vehiclesServiced.value} vehicles were serviced, ` +
            `${up ? 'up' : 'down'} from ${s.vehiclesServiced.prev} in the previous period ` +
            `(${up ? '+' : '−'}${Math.abs(s.vehiclesServiced.diff)}).`,
          significance: Math.abs(s.vehiclesServiced.diff) * 20,
          evidence: { metric: 'vehiclesServiced', value: s.vehiclesServiced.value, prev: s.vehiclesServiced.prev },
        });
      }
    }

    // 7. Appointment vs walk-in gap (within-period).
    const a = input.sourceComparison.appointment;
    const w = input.sourceComparison.walkIn;
    if (a.jobsCompleted >= M.sourceMinJobs && w.jobsCompleted >= M.sourceMinJobs) {
      const slower = a.avgElapsedMs > w.avgElapsedMs ? a : w;
      const faster = slower === a ? w : a;
      const gapPct = pctOf(slower.avgElapsedMs - faster.avgElapsedMs, faster.avgElapsedMs);
      if (gapPct != null && gapPct >= M.sourceGapPct) {
        out.push({
          id: 'SOURCE_GAP',
          tone: 'attention',
          title: `${slower === a ? 'Appointments' : 'Walk-Ins'} Running Slower`,
          detail:
            `${slower === a ? 'Appointment' : 'Walk-in'} jobs averaged ${fmtDurS(slower.avgElapsedMs)} elapsed ` +
            `against ${fmtDurS(faster.avgElapsedMs)} for ${slower === a ? 'walk-ins' : 'appointments'} — a ${gapPct}% gap.`,
          significance: ((slower.avgElapsedMs - faster.avgElapsedMs) / 60000) * slower.jobsCompleted,
          evidence: {
            metric: 'sourceGap',
            appointmentAvgMs: a.avgElapsedMs,
            walkInAvgMs: w.avgElapsedMs,
          },
        });
      }
    }

    // 8. Services materially over target (within-period).
    const over = input.serviceRows
      .filter(
        (r) =>
          r.volume >= M.serviceMinVolume &&
          r.varianceElapsedMs >= M.serviceOverMinMs &&
          r.targetMinutes > 0 &&
          r.varianceElapsedMs >= (r.targetMinutes * 60000 * M.serviceOverPct) / 100,
      )
      .sort((x, y) => y.varianceElapsedMs * y.volume - x.varianceElapsedMs * x.volume);
    if (over.length > 0) {
      const top = over[0];
      out.push({
        id: 'SERVICE_OVER_TARGET',
        tone: 'attention',
        title: 'Service Running Over Target',
        detail:
          `${top.name} averaged ${fmtDurS(top.avgElapsedMs)} against a booked ${fmtDurS(top.targetMinutes * 60000)} ` +
          `(+${fmtDurS(top.varianceElapsedMs)}) across ${top.volume} jobs` +
          `${over.length > 1 ? `; ${over.length - 1} other service(s) also over target` : ''}.`,
        significance: (top.varianceElapsedMs / 60000) * top.volume,
        evidence: { metric: 'serviceOverTarget', service: top.name, varianceMs: top.varianceElapsedMs, volume: top.volume },
      });
    }

    // 9. Operational exceptions from the attention list.
    if (input.attentionCount > 0) {
      out.push({
        id: 'EXCEPTIONS',
        tone: 'attention',
        title: 'Operational Exceptions Recorded',
        detail: `${input.attentionCount} item${input.attentionCount === 1 ? '' : 's'} exceeded the report's explicit thresholds — see Items Requiring Attention.`,
        significance: input.attentionCount * 15,
        evidence: { metric: 'attentionItems', count: input.attentionCount },
      });
    }

    const rank = (rows: ExecInsight[]) => rows.sort((x, y) => y.significance - x.significance).slice(0, 4);
    return {
      highlights: rank(out.filter((i) => i.tone === 'positive')),
      attention: rank(out.filter((i) => i.tone === 'attention')),
    };
  }
}
