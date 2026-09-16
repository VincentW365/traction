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

/**
 * Which capacity model produced a column.
 *
 * SHADOW is declared now and reports NOT_YET_AVAILABLE until Stage 5 builds the
 * resource-aware engine. Populating it with a half-built pseudo-calculation would
 * be worse than an empty column: it would look like evidence, and the entire
 * point of shadow mode is to decide whether to trust the real one.
 */
export type CapacityModelName = 'FIXED' | 'SHADOW' | 'RESOURCE_AWARE';

export interface ShadowComparison {
  status: 'NOT_YET_AVAILABLE' | 'AVAILABLE';
  /** Why there is nothing to compare against yet. */
  note?: string;
}

export interface SimulationResult {
  site: { id: string; code: string; name: string; timezone: string };
  audience: BookingAudience;
  plannedMinutes: number;
  latestStartLabel: string | null;
  range: { from: string; to: string };
  services: Array<{ code: string; name: string; baseDurationMinutes: number | null }>;
  /** The model that decided what a real customer sees right now. */
  productionModel: CapacityModelName;
  shadow: ShadowComparison;
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
  }): Promise<SimulationResult> {
    const site = await this.resolveSite();
    const audience: BookingAudience = opts.audience ?? 'CUSTOMER';

    const codes = opts.serviceCodes.map((c) => c.trim()).filter(Boolean);
    if (codes.length === 0) throw new BadRequestException('Choose at least one service to simulate.');
    const services = await this.prisma.serviceType.findMany({
      where: { code: { in: codes } },
      select: { code: true, name: true, baseDurationMinutes: true },
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

    return {
      site,
      audience,
      plannedMinutes: context.plannedMinutes,
      latestStartLabel: context.latestStartLabel,
      range: context.range,
      services,
      // Stage 5 will switch this to whatever `booking_capacity_model` says.
      productionModel: 'FIXED',
      shadow: {
        status: 'NOT_YET_AVAILABLE',
        note:
          'The resource-aware model is Stage 5 and is not built yet. This column stays empty on purpose: ' +
          'a partial calculation shown here would look like evidence, and shadow mode exists precisely to decide ' +
          'whether the real one can be trusted.',
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
