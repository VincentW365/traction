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
import {
  resolveAppointmentDuration,
  type DurationResolution,
  type MeasurableService,
  type VehicleClass,
} from './service-duration';

export type BookingAudience = 'CUSTOMER' | 'STAFF';

/**
 * CR-2026-111b — durations come from ONE resolver, shared with every staff path.
 *
 * This file used to own the rule, with the class columns marked optional "so every
 * existing caller keeps compiling". That optionality is precisely how the staff
 * path came to plan an SUV general service at 90 minutes while the customer path
 * planned 120. The rule now lives in `service-duration.ts`, where the columns are
 * required and a caller that has not loaded them does not compile.
 */
export type { MeasurableService, DurationPolicy, DurationResolution, VehicleClass } from './service-duration';
export {
  SERVICE_DURATION_SELECT,
  catalogueMinutesFor,
  resolveAppointmentDuration,
  variesByVehicleClass,
} from './service-duration';

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
   * CR-2026-111b — the full duration answer, for anything that needs to REASON
   * about the number rather than just use it: an activation preflight comparing
   * what a service is configured to take against what production would plan, or a
   * report that must say why.
   *
   * Every scheduling path here and in the staff module goes through this, so a
   * customer booking and an advisor booking cannot disagree (§3, §4).
   */
  resolveDuration(services: MeasurableService[], rules: BookingRuleSet, vehicleClass: VehicleClass = null): DurationResolution {
    return resolveAppointmentDuration({
      services,
      vehicleClass,
      policy: rules.booking.durationSource === 'CATALOGUE' ? 'CATALOGUE' : 'DEFAULT',
      defaultMinutes: rules.eta.defaultDurationMinutes,
    });
  }

  /**
   * Assumption 2 (docs/120): management's flat default unless the catalogue is
   * explicitly enabled — see `service-duration.ts` for the policy/duration split.
   */
  plannedMinutes(services: MeasurableService[], rules: BookingRuleSet, vehicleClass: VehicleClass = null): number {
    return this.resolveDuration(services, rules, vehicleClass).plannedMinutes;
  }

  slotRules(
    services: MeasurableService[],
    rules: BookingRuleSet,
    audience: BookingAudience,
    vehicleClass: VehicleClass = null,
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

  /**
   * CR-2026-111b — the vehicle's service class, read from the VEHICLE RECORD.
   *
   * It lives here, on the one engine both modules already inject, so customer and
   * staff paths resolve a class the same way instead of each keeping a copy. Never
   * taken from a request: a caller must not be able to assert "sedan" and buy a
   * shorter slot than the work needs.
   *
   * `null` means not classified. The resolver treats that conservatively (§5) —
   * it does not quietly pick the shorter standard.
   */
  async vehicleClassOf(vehicleId?: string | null): Promise<VehicleClass> {
    if (!vehicleId) return null;
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { serviceClass: true },
    });
    return (vehicle?.serviceClass as VehicleClass) ?? null;
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
    services: MeasurableService[],
    opts: { from?: string; days?: number; audience: BookingAudience; excludeAppointmentId?: string | null; now?: Date; rules?: BookingRuleSet; vehicleClass?: VehicleClass },
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
    services: MeasurableService[],
    opts: { from?: string; days?: number; audience: BookingAudience; excludeAppointmentId?: string | null; now?: Date; rules?: BookingRuleSet; vehicleClass?: VehicleClass },
  ): Promise<AvailabilityContext & { decision: AvailabilityDecision }> {
    const rules = opts.rules ?? (await this.loadRules(site.id));
    const now = opts.now ?? new Date();
    const dayInputs = this.dayInputs(site, rules, opts.audience, opts.from, opts.days, now);
    const existing = await this.existingBookings(site.id, dayInputs, this.prisma, opts.excludeAppointmentId ?? null);
    const slotRules = this.slotRules(services, rules, opts.audience, opts.vehicleClass ?? null);
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
