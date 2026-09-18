/**
 * CR-2026-108 Stage 5C — FIXED vs RESOURCE_AWARE, side by side.
 *
 * SHADOW mode exists to answer one question before a customer is ever exposed to
 * the resource model: where would it have disagreed with the fixed limit, and was
 * it right to? Two disagreements matter, and they matter for opposite reasons:
 *
 *   FIXED offered, SHADOW would not   — the shop is being oversold. A customer is
 *                                       given a time no eligible bay can cover.
 *   FIXED refused, SHADOW would offer — the shop is being undersold. Real capacity
 *                                       is sitting behind a global number of 2.
 *
 * WHAT IS STORED, AND WHAT IS NOT
 *
 * Only differences. Agreement is the expected case and writing it would bury the
 * signal under millions of rows nobody reads. And only slots where the fixed
 * engine actually reached a CAPACITY decision: a slot excluded because it is in
 * the past is not a disagreement about capacity, and logging it would drown the
 * table in noise the resource engine has no opinion about.
 *
 * No PII. No customer, vehicle, plate, appointment id or token — a disagreement is
 * a fact about the workshop, not about a person, and analysts reading this table
 * have no business seeing either.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { AvailabilityDecision, SlotDecision, SlotReasonCode } from './slot-decision';
// Value import, not `import type`: Nest resolves constructor dependencies from
// the emitted design:paramtypes metadata, and a type-only import leaves nothing
// there to resolve.
import { ResourceAvailabilityService } from './resource-availability.service';
import type { ResourceSnapshot } from './resource-availability.service';
import type { ResourceCapacityDecision, ResourceDecisionStatus } from './resource-capacity.engine';

/** Where a comparison came from. Analysts filter on it constantly. */
export type EvaluationSource = 'PUBLIC_AVAILABILITY' | 'STAFF_AVAILABILITY' | 'SIMULATOR' | 'VALIDATION';

/**
 * How long a comparison is kept. Long enough to cover a full seasonal swing and
 * to review a change made a month ago; short enough that the table stays a
 * diagnostic rather than an archive.
 */
export const SHADOW_RETENTION_DAYS = 90;

/**
 * Reason codes where the fixed engine actually decided on CAPACITY. Anything else
 * is a timing or calendar rule the resource model has no view on.
 */
const CAPACITY_DECIDED: readonly SlotReasonCode[] = ['AVAILABLE', 'FIXED_CAPACITY_REACHED'];

export interface SlotComparison {
  startAt: string;
  endAt: string;
  fixed: { available: boolean; reasonCode: SlotReasonCode; rule?: string };
  shadow: {
    status: ResourceDecisionStatus;
    available: boolean;
    reasonCode: ResourceCapacityDecision['reasonCode'];
    label: string;
    detail: string;
    eligiblePositions: number;
    remainingPositions: number;
    eligibleCodes: string[];
  };
  /** False when the two models would have given the customer different answers. */
  agrees: boolean;
}

export interface ShadowComparisonRun {
  productionModel: 'FIXED';
  shadowModel: 'RESOURCE_AWARE';
  requiredCapability: string | null;
  configurationComplete: boolean;
  unverifiedResourceCount: number;
  fingerprint: string;
  /**
   * `agree + oversold + undersold + incomplete === slotsCompared`. The four are
   * mutually exclusive, and INCOMPLETE takes precedence: a slot the resource
   * model could not evaluate is a configuration gap, not a disagreement about
   * capacity, and counting it as one would turn an unfinished spreadsheet into a
   * critical safety finding.
   */
  summary: {
    slotsCompared: number;
    agree: number;
    oversold: number;
    undersold: number;
    incomplete: number;
    /** Eligible positions for this capability, once. Never summed with others. */
    eligiblePositions: number;
  };
  days: Array<{ date: string; slots: SlotComparison[] }>;
  /** One sentence naming what the comparison found. */
  headline: string;
}

@Injectable()
export class ShadowComparisonService {
  private readonly logger = new Logger('ShadowComparison');

  constructor(
    private readonly prisma: PrismaService,
    private readonly resources: ResourceAvailabilityService,
  ) {}

  /**
   * Run the resource model over a decision the fixed model already produced.
   *
   * Takes the fixed decision rather than recomputing it: the entire value of a
   * shadow comparison is that both columns describe the same request. A
   * re-derived left-hand column would be comparing two guesses.
   */
  compare(
    decision: AvailabilityDecision,
    snapshot: ResourceSnapshot,
    candidate: { requiredCapability: string | null; vehicleClass: string | null },
    opts: { excludeAppointmentId?: string | null } = {},
  ): ShadowComparisonRun {
    const days: ShadowComparisonRun['days'] = [];
    let slotsCompared = 0;
    let agree = 0;
    let oversold = 0;
    let undersold = 0;
    let incomplete = 0;
    let eligiblePositions = 0;

    for (const day of decision.days) {
      const slots: SlotComparison[] = [];
      for (const slot of day.slots) {
        if (!CAPACITY_DECIDED.includes(slot.reasonCode)) continue;
        const shadow = this.resources.evaluate(
          snapshot,
          {
            startAt: new Date(slot.startAt),
            endAt: new Date(slot.endAt),
            requiredCapability: candidate.requiredCapability,
            vehicleClass: candidate.vehicleClass,
          },
          opts.excludeAppointmentId ?? null,
        );
        eligiblePositions = shadow.eligiblePositions;
        const agrees = shadow.available === slot.available;
        slotsCompared++;

        // These three are MUTUALLY EXCLUSIVE, and INCOMPLETE wins.
        //
        // An INCOMPLETE slot has `available: false`, so a naive reading counts it
        // as the fixed model overselling — 708 of them on a shop where nobody has
        // assigned LUBE yet. That is not evidence the workshop is being oversold;
        // it is evidence nobody has said which bay does oil changes, and the two
        // must never be added together. The preflight blocks on `oversold`, so
        // conflating them would raise a critical safety finding out of an
        // unfinished configuration.
        if (shadow.status === 'INCOMPLETE') incomplete++;
        else if (agrees) agree++;
        else if (slot.available) oversold++;
        else undersold++;

        slots.push({
          startAt: slot.startAt,
          endAt: slot.endAt,
          fixed: { available: slot.available, reasonCode: slot.reasonCode, rule: slot.rule },
          shadow: {
            status: shadow.status,
            available: shadow.available,
            reasonCode: shadow.reasonCode,
            label: shadow.label,
            detail: shadow.detail,
            eligiblePositions: shadow.eligiblePositions,
            remainingPositions: shadow.remainingPositions,
            eligibleCodes: shadow.eligibleCodes,
          },
          agrees,
        });
      }
      if (slots.length > 0) days.push({ date: day.date, slots });
    }

    const configurationComplete = snapshot.unverifiedResourceCount === 0;
    return {
      productionModel: 'FIXED',
      shadowModel: 'RESOURCE_AWARE',
      requiredCapability: candidate.requiredCapability,
      configurationComplete,
      unverifiedResourceCount: snapshot.unverifiedResourceCount,
      fingerprint: snapshot.fingerprint,
      summary: { slotsCompared, agree, oversold, undersold, incomplete, eligiblePositions },
      days,
      headline: headlineFor({ slotsCompared, agree, oversold, undersold, incomplete, configurationComplete }),
    };
  }

  /**
   * Persist the disagreements. Never throws into the caller: a shadow model that
   * could break a customer's booking page would defeat the purpose of running it
   * out of the way in the first place.
   */
  async record(
    siteId: string,
    run: ShadowComparisonRun,
    context: { serviceCodes: string[]; plannedMinutes: number; vehicleClass: string | null; source: EvaluationSource },
  ): Promise<{ written: number }> {
    try {
      const rows = run.days.flatMap((d) =>
        d.slots
          .filter((s) => !s.agrees)
          .map((s) => ({
            siteId,
            evaluationSource: context.source,
            serviceCodes: context.serviceCodes,
            requiredCapability: run.requiredCapability,
            slotStartAt: new Date(s.startAt),
            slotEndAt: new Date(s.endAt),
            plannedMinutes: context.plannedMinutes,
            vehicleClass: context.vehicleClass,
            fixedAvailable: s.fixed.available,
            fixedReasonCode: s.fixed.reasonCode,
            resourceAvailable: s.shadow.available,
            resourceReasonCode: s.shadow.label,
            resourceStatus: s.shadow.status,
            eligiblePositions: s.shadow.eligiblePositions,
            remainingPositions: s.shadow.remainingPositions,
            configurationComplete: run.configurationComplete,
            configFingerprint: run.fingerprint,
          })),
      );
      if (rows.length === 0) return { written: 0 };
      await this.prisma.bookingShadowComparison.createMany({ data: rows });
      return { written: rows.length };
    } catch (err) {
      this.logger.warn(`Shadow comparison not recorded: ${err instanceof Error ? err.message : String(err)}`);
      return { written: 0 };
    }
  }

  /** Retention (§12). Run from the existing housekeeping schedule. */
  async purgeExpired(now = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(now.getTime() - SHADOW_RETENTION_DAYS * 24 * 60 * 60_000);
    const { count } = await this.prisma.bookingShadowComparison.deleteMany({ where: { observedAt: { lt: cutoff } } });
    return { deleted: count };
  }

  /** What the recorded disagreements add up to. Read-only, for the report. */
  async findings(siteId?: string, sinceDays = SHADOW_RETENTION_DAYS) {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60_000);
    const where = { observedAt: { gte: since }, ...(siteId ? { siteId } : {}) };
    const [total, byCapability, oversold, undersold, incomplete, fingerprints] = await Promise.all([
      this.prisma.bookingShadowComparison.count({ where }),
      this.prisma.bookingShadowComparison.groupBy({ by: ['requiredCapability', 'resourceReasonCode'], where, _count: { _all: true } }),
      this.prisma.bookingShadowComparison.count({ where: { ...where, fixedAvailable: true, resourceAvailable: false } }),
      this.prisma.bookingShadowComparison.count({ where: { ...where, fixedAvailable: false, resourceAvailable: true } }),
      this.prisma.bookingShadowComparison.count({ where: { ...where, resourceStatus: 'INCOMPLETE' } }),
      this.prisma.bookingShadowComparison.findMany({ where, distinct: ['configFingerprint'], select: { configFingerprint: true } }),
    ]);
    return {
      sinceDays,
      total,
      oversold,
      undersold,
      incomplete,
      /** More than one means the shop was reconfigured mid-window; read with care. */
      configurationsObserved: fingerprints.length,
      byCapability: byCapability
        .map((g) => ({ capability: g.requiredCapability, reason: g.resourceReasonCode, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }
}

function headlineFor(s: {
  slotsCompared: number;
  agree: number;
  oversold: number;
  undersold: number;
  incomplete: number;
  configurationComplete: boolean;
}): string {
  if (s.slotsCompared === 0) return 'No slot reached a capacity decision, so there was nothing to compare.';
  if (s.incomplete === s.slotsCompared) {
    return 'The resource model could not evaluate any slot — the configuration is incomplete for this service. This is not a capacity finding.';
  }
  const parts: string[] = [];
  if (s.oversold > 0) parts.push(`${s.oversold} slot(s) offered by the fixed limit that no eligible position could cover`);
  if (s.undersold > 0) parts.push(`${s.undersold} slot(s) the fixed limit refused where positions were free`);
  if (parts.length === 0) return `Both models agreed on all ${s.slotsCompared} slots.`;
  const caveat = s.configurationComplete ? '' : ' Counts are a lower bound while resources remain unclassified.';
  return `${parts.join('; ')}.${caveat}`;
}
