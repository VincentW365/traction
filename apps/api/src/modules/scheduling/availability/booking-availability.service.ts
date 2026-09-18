/**
 * CR-2026-106 — the ONE booking-availability service (docs/121 §D "Engine parity").
 *
 * Before this, the public booking page ran the pure availability engine while
 * staff typed a free time into the appointment form; the two could disagree
 * about what "available" meant (duration source, capacity, the day lock). Every
 * consumer — the public /book flow, the staff wizard, staff create/reschedule —
 * now asks this service the same question with an explicit AUDIENCE:
 *
 *  - CUSTOMER: minimum notice, advance window, same-day rule, closed dates, the
 *    latest customer start (`customer_booking_latest_start`, e.g. 15:00) — all
 *    enforced on the server; the browser only displays what it is given.
 *  - STAFF: no minimum notice, any day the site is open, no advance-window cap;
 *    the latest-start rule applies only when `staff_latest_start_enforced` is on,
 *    and can then be overridden explicitly (audited by the caller).
 *
 * Capacity (concurrent service positions) and the planned duration come from the
 * ETA rules — one business fact — so an advisor's booking and a customer's booking
 * consume the same constrained positions and each sees the other immediately.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { EtaService } from '../eta/eta.service';
import type { EtaRuleValues } from '../eta/eta.config';
import {
  addDaysToKey,
  dayInstant,
  dayWindow,
  isWindowWithinOperatingHours,
  loadOperatingHours,
  localDayKey,
  type OperatingHoursConfig,
} from '../../../common/helpers/operating-hours';
import { BOOKING_RULE_KEYS, bookingRulesFromRows, type BookingRules } from '../../public-booking/booking.config';
import {
  computeAvailabilityDecision,
  isSlotAvailable,
  type AvailabilityResult,
  type DayInput,
  type ExistingBooking,
  type SlotRules,
} from '../../public-booking/availability.engine';
import { toCustomerAvailability, type AvailabilityDecision } from './slot-decision';

export type BookingAudience = 'CUSTOMER' | 'STAFF';

/**
 * A service, as the duration calculation needs to see it. The two class-specific
 * columns are optional so every existing caller keeps compiling — and so that a
 * service which takes the same time on everything says nothing at all rather than
 * repeating one number three times.
 */
export interface DurationCandidate {
  baseDurationMinutes: number | null;
  sedanDurationMinutes?: number | null;
  suvDurationMinutes?: number | null;
}

/**
 * CR-2026-111 — how long one service takes on THIS vehicle.
 *
 * An unknown class deliberately gets `baseDurationMinutes`, which for a
 * class-split service is the sedan figure. That is the shorter promise, and the
 * asymmetry is on purpose: a slot that finishes early is an inconvenience, a slot
 * that overruns holds a bay the next customer was booked into.
 */
export function serviceMinutes(s: DurationCandidate, vehicleClass?: string | null): number {
  if (vehicleClass === 'SUV_CLASS' && s.suvDurationMinutes && s.suvDurationMinutes > 0) return s.suvDurationMinutes;
  if (vehicleClass === 'SEDAN_CLASS' && s.sedanDurationMinutes && s.sedanDurationMinutes > 0) return s.sedanDurationMinutes;
  return s.baseDurationMinutes && s.baseDurationMinutes > 0 ? s.baseDurationMinutes : 0;
}

export interface BookingRuleSet {
  booking: BookingRules;
  eta: EtaRuleValues;
  hours: OperatingHoursConfig | null;
}

export interface SiteLike {
  id: string;
  timezone: string;
}

/** Appointment statuses that still hold a service position. */
export const ACTIVE_APPOINTMENT_STATUSES = ['DRAFT', 'CONFIRMED', 'RESCHEDULED', 'CHECKED_IN', 'IN_PROGRESS'] as const;

const MS = 60_000;
const DAY_MS = 24 * 60 * MS;
/** Staff may look further ahead than customers, but one request stays bounded. */
const STAFF_MAX_DAYS_PER_REQUEST = 31;

/** Context that accompanies any availability answer, rich or projected. */
export interface AvailabilityContext {
  plannedMinutes: number;
  timezone: string;
  audience: BookingAudience;
  /** "3:00 PM" when a latest-start rule applies to this audience, else null. */
  latestStartLabel: string | null;
  /** The window actually computed (first/last day keys), for pagers. */
  range: { from: string; to: string };
}

/** The customer-safe answer: context plus times-and-a-boolean. */
export interface AvailabilityView extends AvailabilityResult, AvailabilityContext {}

/** "15:00" → "3:00 PM" (site-local wall clock; no zone maths needed). */
export function formatLatestStartLabel(hhmm: string | null | undefined): string | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

@Injectable()
export class BookingAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eta: EtaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  async loadRules(siteId: string): Promise<BookingRuleSet> {
    const [rows, eta, hours] = await Promise.all([
      this.prisma.businessRuleConfig.findMany({
        where: { ruleKey: { in: [...BOOKING_RULE_KEYS] }, effectiveTo: null, OR: [{ siteId }, { siteId: null }] },
        select: { ruleKey: true, valueJson: true, siteId: true },
      }),
      this.eta.loadRules(siteId),
      loadOperatingHours(this.prisma as never, siteId),
    ]);
    return { booking: bookingRulesFromRows(rows), eta, hours };
  }

  /** The latest-start wall-clock rule that applies to this audience, or null. */
  latestStartRule(rules: BookingRuleSet, audience: BookingAudience): string | null {
    const v = rules.booking.customerLatestStart;
    if (!v) return null;
    if (audience === 'CUSTOMER') return v;
    return rules.booking.staffLatestStartEnforced ? v : null;
  }

  /**
   * Assumption 2 (docs/120): management's 80 minutes unless the catalogue is
   * explicitly enabled.
   *
   * CR-2026-111 — a service may declare that it takes longer on a bigger vehicle
   * (General Servicing is 90 for a sedan and 120 for an SUV, per the standard
   * management approved). That split is honoured when the class is known; an
   * unknown class falls back to `baseDurationMinutes`, which is deliberately the
   * SHORTER of the two. Under-promising a slot is recoverable; over-promising one
   * leaves a vehicle occupying a bay somebody else was booked into.
   *
   * None of this is in force while `appointment_duration_source` is DEFAULT,
   * which is production today — every booking is planned at the standard length
   * whatever the service. The capability exists so the switch, when it is taken,
   * does not also need this built underneath it.
   */
  plannedMinutes(services: DurationCandidate[], rules: BookingRuleSet, vehicleClass?: string | null): number {
    if (rules.booking.durationSource === 'CATALOGUE') {
      const sum = services.reduce((s, t) => s + Math.max(0, serviceMinutes(t, vehicleClass)), 0);
      if (sum > 0) return sum;
    }
    return rules.eta.defaultDurationMinutes;
  }

  slotRules(
    services: DurationCandidate[],
    rules: BookingRuleSet,
    audience: BookingAudience,
    vehicleClass?: string | null,
  ): SlotRules {
    return {
      slotIntervalMinutes: rules.booking.slotIntervalMinutes,
      minNoticeMinutes: audience === 'STAFF' ? 0 : rules.booking.minNoticeMinutes,
      sameDayAllowed: audience === 'STAFF' ? true : rules.booking.sameDayAllowed,
      capacity: rules.eta.capacity,
      durationMinutes: this.plannedMinutes(services, rules, vehicleClass),
      defaultDurationMinutes: rules.eta.defaultDurationMinutes,
    };
  }

  // ---------------------------------------------------------------------------
  // Days + existing bookings
  // ---------------------------------------------------------------------------

  dayInputs(site: SiteLike, rules: BookingRuleSet, audience: BookingAudience, from: string | undefined, days: number | undefined, now = new Date()): DayInput[] {
    const today = localDayKey(now, site.timezone);
    const first = from && from >= today ? from : today;
    const latest = this.latestStartRule(rules, audience);
    let count: number;
    let lastAllowed: string | null;
    if (audience === 'CUSTOMER') {
      lastAllowed = addDaysToKey(today, rules.booking.advanceWindowDays);
      count = Math.min(days ?? 14, rules.booking.advanceWindowDays + 1);
    } else {
      lastAllowed = null;
      count = Math.min(days ?? 14, STAFF_MAX_DAYS_PER_REQUEST);
    }
    const out: DayInput[] = [];
    for (let i = 0; i < count; i++) {
      const key = addDaysToKey(first, i);
      if (lastAllowed && key > lastAllowed) break;
      out.push({
        dateKey: key,
        window: dayWindow(rules.hours, key, site.timezone),
        isClosedDate: audience === 'CUSTOMER' && rules.booking.closedDates.includes(key),
        isToday: key === today,
        latestStart: latest ? dayInstant(key, latest, site.timezone) : null,
      });
    }
    return out;
  }

  /** Active appointments that could overlap any of the given days (± a day for safety). */
  async existingBookings(
    siteId: string,
    days: DayInput[],
    client: Pick<Prisma.TransactionClient, 'appointment'> | PrismaService,
    excludeAppointmentId: string | null = null,
  ): Promise<ExistingBooking[]> {
    const windows = days.map((d) => d.window).filter((w): w is { open: Date; close: Date } => !!w);
    if (windows.length === 0) return [];
    const from = new Date(Math.min(...windows.map((w) => w.open.getTime())) - DAY_MS);
    const to = new Date(Math.max(...windows.map((w) => w.close.getTime())) + DAY_MS);
    const rows = await client.appointment.findMany({
      where: {
        siteId,
        status: { in: [...ACTIVE_APPOINTMENT_STATUSES] as never[] },
        scheduledStartAt: { gte: from, lte: to },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { scheduledStartAt: true, scheduledEndAt: true },
    });
    return rows.map((r) => ({ startAt: r.scheduledStartAt, endAt: r.scheduledEndAt }));
  }

  // ---------------------------------------------------------------------------
  // The question every screen asks
  // ---------------------------------------------------------------------------

  async availability(
    site: SiteLike,
    services: DurationCandidate[],
    opts: { from?: string; days?: number; audience: BookingAudience; excludeAppointmentId?: string | null; now?: Date; rules?: BookingRuleSet; vehicleClass?: string | null },
  ): Promise<AvailabilityView> {
    const { decision, ...context } = await this.availabilityDecision(site, services, opts);
    // CR-2026-108 Stage 2 — the public/staff surfaces get the customer-safe
    // projection: times and a boolean, never a reason code, a capacity number or
    // a rule value. Diagnostics are for admin tooling (the Stage 3 simulator),
    // which calls `availabilityDecision` directly.
    return { ...context, ...toCustomerAvailability(decision) };
  }

  /**
   * CR-2026-108 Stage 2 — the SAME computation, undiminished: every candidate
   * slot with the reason it was or was not offered, the capacity arithmetic
   * behind it, and the rule that decided. This is what the Booking Simulator
   * consumes, so an analyst sees exactly what the customer's request produced —
   * not a re-implementation of it.
   */
  async availabilityDecision(
    site: SiteLike,
    services: DurationCandidate[],
    opts: { from?: string; days?: number; audience: BookingAudience; excludeAppointmentId?: string | null; now?: Date; rules?: BookingRuleSet; vehicleClass?: string | null },
  ): Promise<AvailabilityContext & { decision: AvailabilityDecision }> {
    const rules = opts.rules ?? (await this.loadRules(site.id));
    const now = opts.now ?? new Date();
    const dayInputs = this.dayInputs(site, rules, opts.audience, opts.from, opts.days, now);
    const existing = await this.existingBookings(site.id, dayInputs, this.prisma, opts.excludeAppointmentId ?? null);
    const slotRules = this.slotRules(services, rules, opts.audience, opts.vehicleClass);
    const decision = computeAvailabilityDecision(now, dayInputs, existing, slotRules);
    return {
      plannedMinutes: slotRules.durationMinutes,
      timezone: site.timezone,
      audience: opts.audience,
      latestStartLabel: formatLatestStartLabel(this.latestStartRule(rules, opts.audience)),
      range: {
        from: dayInputs[0]?.dateKey ?? localDayKey(now, site.timezone),
        to: dayInputs[dayInputs.length - 1]?.dateKey ?? localDayKey(now, site.timezone),
      },
      decision,
    };
  }

  // ---------------------------------------------------------------------------
  // Placement rules (server-side; the browser only displays)
  // ---------------------------------------------------------------------------

  /**
   * Throws when the slot may not be placed for this audience. Returns whether a
   * latest-start override was USED (so the caller audits it).
   */
  assertSlotAllowed(
    start: Date,
    end: Date,
    site: SiteLike,
    rules: BookingRuleSet,
    audience: BookingAudience,
    opts: { overrideLatestStart?: boolean; now?: Date } = {},
  ): { latestStartOverridden: boolean } {
    const now = opts.now ?? new Date();
    const dayKey = localDayKey(start, site.timezone);
    if (audience === 'CUSTOMER') {
      if (start.getTime() < now.getTime() + rules.booking.minNoticeMinutes * MS) {
        throw new BadRequestException(`Appointments need at least ${rules.booking.minNoticeMinutes} minutes' notice.`);
      }
      if (start.getTime() > now.getTime() + (rules.booking.advanceWindowDays + 1) * DAY_MS) {
        throw new BadRequestException(`Appointments can be booked up to ${rules.booking.advanceWindowDays} days ahead.`);
      }
      if (rules.booking.closedDates.includes(dayKey)) throw new BadRequestException('The service centre is closed on that date.');
      if (dayKey === localDayKey(now, site.timezone) && !rules.booking.sameDayAllowed) {
        throw new BadRequestException('Same-day online booking is not available. Please call the service centre.');
      }
      if (!isWindowWithinOperatingHours(start, end, rules.hours, site.timezone)) {
        throw new BadRequestException('That time is outside our opening hours.');
      }
    }

    const latest = this.latestStartRule(rules, audience);
    let latestStartOverridden = false;
    if (latest) {
      const cutoff = dayInstant(dayKey, latest, site.timezone);
      if (cutoff && start.getTime() > cutoff.getTime()) {
        if (audience === 'STAFF' && opts.overrideLatestStart) {
          latestStartOverridden = true;
        } else {
          const label = formatLatestStartLabel(latest);
          throw new BadRequestException({
            code: 'AFTER_LATEST_START',
            message:
              audience === 'CUSTOMER'
                ? `Appointments must start by ${label}. Please choose an earlier time.`
                : `Appointments start no later than ${label} (rule: staff_latest_start_enforced). Tick "book after the latest start anyway" to override — this will be recorded.`,
            latestStart: latest,
            latestStartLabel: label,
          });
        }
      }
    }
    return { latestStartOverridden };
  }

  // ---------------------------------------------------------------------------
  // Transactional protection — the same lock for every writer
  // ---------------------------------------------------------------------------

  /** Per-site-per-day advisory lock: two writers claiming the last position serialise. */
  async lockDay(tx: Prisma.TransactionClient, siteId: string, dayKey: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${siteId}:${dayKey}`}))`;
  }

  /** With the lock held: is the slot still free for this audience's rules? */
  async slotStillAvailable(
    tx: Prisma.TransactionClient,
    siteId: string,
    start: Date,
    slotRules: SlotRules,
    excludeAppointmentId: string | null = null,
  ): Promise<{ available: boolean; booked: number; capacity: number }> {
    const end = new Date(start.getTime() + slotRules.durationMinutes * MS);
    const existing = await this.existingBookings(
      siteId,
      [{ dateKey: 'lock', window: { open: start, close: end }, isClosedDate: false, isToday: false }],
      tx,
      excludeAppointmentId,
    );
    const available = isSlotAvailable(existing, start, slotRules);
    // Count for the staff message: how many overlap right now.
    const booked = existing.filter((b) => {
      const s = b.startAt.getTime();
      const e = (b.endAt ?? new Date(s + slotRules.defaultDurationMinutes * MS)).getTime();
      return s < end.getTime() && e > start.getTime();
    }).length;
    return { available, booked, capacity: Math.max(1, slotRules.capacity) };
  }
}
