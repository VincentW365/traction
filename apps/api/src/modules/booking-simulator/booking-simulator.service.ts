/**
 * CR-2026-108 Stage 3 — the Admin Booking Simulator.
 *
 * Exists so an administrator or analyst can answer "why is a customer not being
 * offered Tuesday at 10?" without reading logs or guessing. It runs the SAME
 * production availability service the public page runs — `availabilityDecision`,
 * not a test-only copy — and shows the internal decision behind every slot.
 *
 * If this ever re-implemented availability, it would answer a question about a
 * system that does not exist. The whole value is that it is the same computation.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { BookingAvailabilityService, type BookingAudience } from '../scheduling/availability/booking-availability.service';
import type { AvailabilityDecision } from '../scheduling/availability/slot-decision';
import { ResourceAvailabilityService, primaryCapability } from '../scheduling/availability/resource-availability.service';
import { ShadowComparisonService, type ShadowComparisonRun } from '../scheduling/availability/shadow-comparison.service';
import { AuditService } from '../audit/audit.service';
import {
  signUatLaunchToken,
  signUatSessionCookie,
  verifyUatLaunchToken,
  UAT_LAUNCH_TTL_MINUTES,
  UAT_SESSION_TTL_MINUTES,
  type UatContext,
  type UatLaunchRejection,
} from './uat-session';

/** Which capacity model produced a column. */
export type CapacityModelName = 'FIXED' | 'SHADOW' | 'RESOURCE_AWARE';

export interface SimulationResult {
  site: { id: string; code: string; name: string; timezone: string };
  audience: BookingAudience;
  plannedMinutes: number;
  latestStartLabel: string | null;
  range: { from: string; to: string };
  services: Array<{ code: string; name: string; baseDurationMinutes: number | null; requiredBayType: string | null }>;
  /** The model that decided what a real customer sees right now. */
  productionModel: CapacityModelName;
  /**
   * CR-2026-108 Stage 5C — the real resource-aware comparison, slot by slot.
   *
   * Both columns describe the SAME request: the shadow run is given the decision
   * the fixed model already produced rather than recomputing it, because two
   * independently derived columns would be comparing two guesses.
   */
  shadow: ShadowComparisonRun;
  /** What the resource model was looking at, so a disagreement can be explained. */
  resourceConfiguration: {
    verifiedActivePositions: number;
    unverifiedResources: number;
    capabilityPositions: Record<string, number>;
    fingerprint: string;
    requiredCapability: string | null;
  };
  /** The rich, unprojected decision — admin-only by construction of the caller. */
  decision: AvailabilityDecision;
}

@Injectable()
export class BookingSimulatorService {
  private readonly logger = new Logger('BookingSimulator');

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: BookingAvailabilityService,
    private readonly audit: AuditService,
    private readonly resources: ResourceAvailabilityService,
    private readonly shadow: ShadowComparisonService,
  ) {}

  private async resolveSite() {
    const site = await this.prisma.site.findFirst({ select: { id: true, code: true, name: true, timezone: true } });
    if (!site) throw new BadRequestException('No site is configured on this deployment.');
    return site;
  }

  /**
   * Run the real availability question and return everything behind the answer.
   */
  async simulate(opts: {
    serviceCodes: string[];
    from?: string;
    days?: number;
    audience?: BookingAudience;
    excludeAppointmentId?: string | null;
    /** SEDAN_CLASS / SUV_CLASS — restrictions only bite once a class is known. */
    vehicleClass?: string | null;
    /** Persist the disagreements this run found. Off by default: opening the
     *  screen should not fill the evidence table with duplicates of one question. */
    record?: boolean;
  }): Promise<SimulationResult> {
    const site = await this.resolveSite();
    const audience: BookingAudience = opts.audience ?? 'CUSTOMER';

    const codes = opts.serviceCodes.map((c) => c.trim()).filter(Boolean);
    if (codes.length === 0) throw new BadRequestException('Choose at least one service to simulate.');
    const services = await this.prisma.serviceType.findMany({
      where: { code: { in: codes } },
      select: { code: true, name: true, baseDurationMinutes: true, requiredBayType: true },
    });
    if (services.length === 0) throw new BadRequestException(`No service matched: ${codes.join(', ')}`);

    const rules = await this.availability.loadRules(site.id);
    const { decision, ...context } = await this.availability.availabilityDecision(site, services, {
      from: opts.from,
      days: opts.days,
      audience,
      excludeAppointmentId: opts.excludeAppointmentId ?? null,
      rules,
    });

    // --- the shadow column ----------------------------------------------------
    // One snapshot for the whole grid: re-reading per slot would turn this into a
    // hundred queries and let the configuration shift mid-comparison.
    const bounds = slotBounds(decision);
    const snapshot = await this.resources.snapshot(
      site.id,
      bounds ?? { from: new Date(), to: new Date() },
      {
        defaultDurationMinutes: rules.eta.defaultDurationMinutes,
        excludeAppointmentId: opts.excludeAppointmentId ?? null,
      },
    );
    const requiredCapability = primaryCapability(services.map((s) => s.requiredBayType));
    const vehicleClass = opts.vehicleClass ?? null;
    const shadow = this.shadow.compare(decision, snapshot, { requiredCapability, vehicleClass }, {
      excludeAppointmentId: opts.excludeAppointmentId ?? null,
    });

    if (opts.record) {
      await this.shadow.record(site.id, shadow, {
        serviceCodes: services.map((s) => s.code),
        plannedMinutes: context.plannedMinutes,
        vehicleClass,
        source: 'SIMULATOR',
      });
    }

    return {
      site,
      audience,
      plannedMinutes: context.plannedMinutes,
      latestStartLabel: context.latestStartLabel,
      range: context.range,
      services,
      // Production is whatever the rule says. It is FIXED, and Stage 5C does not
      // change that — the resource model runs beside it, not in front of it.
      productionModel: rules.eta.capacityMode === 'RESOURCES' ? 'RESOURCE_AWARE' : 'FIXED',
      shadow,
      resourceConfiguration: {
        verifiedActivePositions: snapshot.activePositions,
        unverifiedResources: snapshot.unverifiedResourceCount,
        capabilityPositions: snapshot.capabilityPositions,
        fingerprint: snapshot.fingerprint,
        requiredCapability,
      },
      decision,
    };
  }

  /**
   * Mint a UAT booking session and hand back a link that launches the real /book
   * flow inside it. Every session is audited — a test booking must always be
   * attributable to the person who authorised it.
   */
  async startUatSession(
    actorUserId: string,
    opts: { label?: string; notes?: string; publicBaseUrl?: string } = {},
  ): Promise<{ token: string; runLabel: string; testDataRunId: string; expiresAt: Date; bookingUrl: string | null; ttlMinutes: number }> {
    const label = (opts.label ?? '').trim() || `uat-booking-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

    const existing = await this.prisma.testDataRun.findUnique({ where: { label }, select: { id: true, status: true } });
    if (existing && existing.status !== 'ACTIVE') {
      throw new BadRequestException(`Test run "${label}" is no longer active — choose a different label.`);
    }
    const run =
      existing ??
      (await this.prisma.testDataRun.create({
        data: {
          label,
          createdByUserId: actorUserId,
          notes: opts.notes ?? 'UAT booking session (CR-2026-108 Stage 3)',
          runType: 'BATCH',
        },
        select: { id: true, status: true },
      }));

    const { token, jti, expiresAt } = signUatLaunchToken({ testDataRunId: run.id, runLabel: label, issuedByUserId: actorUserId });

    await this.audit.log({
      actorUserId,
      action: 'UAT_BOOKING_SESSION_STARTED',
      entityType: 'TestDataRun',
      entityId: run.id,
      afterJson: { runLabel: label, jti, ttlMinutes: UAT_LAUNCH_TTL_MINUTES, expiresAt: expiresAt.toISOString() },
      reasonCode: 'UAT_BOOKING_SESSION',
      notes: 'Records created through /book with this session are tagged to the test run and their notifications are captured.',
    });
    this.logger.log(`UAT launch token for run "${label}" issued by ${actorUserId}, redeemable for ${UAT_LAUNCH_TTL_MINUTES}m.`);

    const base = (opts.publicBaseUrl ?? process.env.PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
    return {
      token,
      runLabel: label,
      testDataRunId: run.id,
      expiresAt,
      ttlMinutes: UAT_LAUNCH_TTL_MINUTES,
      bookingUrl: base ? `${base}/book?uat=${encodeURIComponent(token)}` : null,
    };
  }

  /**
   * Redeem a launch token ONCE and mint the session cookie value.
   *
   * Single use is enforced by recording the token's `jti` when it is redeemed and
   * refusing a second redemption of the same one. The record lives in the audit
   * log rather than in memory so a restart cannot re-open the window — and so the
   * redemption is evidence, not just a guard.
   */
  async redeemUatLaunchToken(
    token: string | null | undefined,
  ): Promise<
    | { ok: true; context: UatContext; cookieValue: string; expiresAt: Date }
    | { ok: false; reason: UatLaunchRejection | 'ALREADY_REDEEMED' }
  > {
    const verified = verifyUatLaunchToken(token);
    if (!verified.ok) {
      this.logger.warn(`UAT launch token refused: ${verified.reason}.`);
      return { ok: false, reason: verified.reason };
    }
    const { jti, testDataRunId, runLabel, issuedByUserId } = verified.claims;

    const alreadyRedeemed = await this.prisma.auditLog.findFirst({
      where: { action: 'UAT_BOOKING_SESSION_REDEEMED', afterJson: { path: ['jti'], equals: jti } },
      select: { id: true },
    });
    if (alreadyRedeemed) {
      this.logger.warn(`UAT launch token ${jti} refused: already redeemed.`);
      return { ok: false, reason: 'ALREADY_REDEEMED' };
    }

    // The run must still be usable; a cleaned-up run must not come back to life.
    const run = await this.prisma.testDataRun.findUnique({ where: { id: testDataRunId }, select: { status: true } });
    if (!run || run.status !== 'ACTIVE') {
      this.logger.warn(`UAT launch token ${jti} refused: test run is ${run?.status ?? 'missing'}.`);
      return { ok: false, reason: 'INCOMPLETE' };
    }

    const context: UatContext = { testDataRunId, runLabel, issuedByUserId };
    const { value, expiresAt } = signUatSessionCookie(context);

    await this.audit.log({
      actorUserId: issuedByUserId,
      action: 'UAT_BOOKING_SESSION_REDEEMED',
      entityType: 'TestDataRun',
      entityId: testDataRunId,
      afterJson: { runLabel, jti, sessionExpiresAt: expiresAt.toISOString(), sessionTtlMinutes: UAT_SESSION_TTL_MINUTES },
      reasonCode: 'UAT_BOOKING_SESSION',
      notes: 'Launch token exchanged for an HttpOnly session cookie; the token cannot be redeemed again.',
    });
    this.logger.log(`UAT launch token ${jti} redeemed for run "${runLabel}".`);

    return { ok: true, context, cookieValue: value, expiresAt };
  }
}

/**
 * The earliest and latest instants any slot in a decision touches.
 *
 * Used to bound the appointment read behind the shadow snapshot. Returns null
 * when a decision produced no slots at all (every day closed), in which case
 * there is nothing to compare and the snapshot window does not matter.
 */
export function slotBounds(decision: AvailabilityDecision): { from: Date; to: Date } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const day of decision.days) {
    for (const slot of day.slots) {
      min = Math.min(min, new Date(slot.startAt).getTime());
      max = Math.max(max, new Date(slot.endAt).getTime());
    }
  }
  return Number.isFinite(min) ? { from: new Date(min), to: new Date(max) } : null;
}
