/**
 * CR-2026-105c — customer self-service pre-booking (docs/120 §D2).
 *
 * A booking made here IS an Appointment — the same row, status machine,
 * check-in and queue flow staff use — with `sourceChannel = CUSTOMER_SELF_SERVICE`,
 * a human-readable reference, and a hashed manage-link token. Nothing parallel.
 *
 * Privacy (CLAUDE.md §10): identification is mobile + plate (two facts only the
 * customer knows); an unmatched pair becomes a NEW customer, never a link to an
 * existing one; every public response carries masked plate/phone, first name at
 * most, and never another customer's data. The manage token is the only
 * credential and is stored as a sha256 hash.
 *
 * Concurrency: the chosen slot is re-checked INSIDE the confirming transaction
 * under `pg_advisory_xact_lock(hashtext('booking:<site>:<day>'))`, so two
 * customers claiming the last position serialise and the second gets 409.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EtaService } from '../scheduling/eta/eta.service';
import type { EtaRuleValues } from '../scheduling/eta/eta.config';
import {
  addDaysToKey,
  dayWindow,
  isWindowWithinOperatingHours,
  loadOperatingHours,
  localDayKey,
  type OperatingHoursConfig,
} from '../../common/helpers/operating-hours';
import { BOOKING_RULE_KEYS, bookingRulesFromRows, type BookingRules } from './booking.config';
import {
  computeAvailability,
  isSlotAvailable,
  type DayInput,
  type ExistingBooking,
  type SlotRules,
} from './availability.engine';
import {
  allocateBookingReference,
  generateManageToken,
  hashManageToken,
  maskPhone,
  maskPlate,
  phoneMatches,
  vehicleCodeForPlate,
} from './booking-reference';
import type { ConfirmBookingDto, IdentifyDto, RescheduleBookingDto } from './dto/public-booking.dto';

/** Appointment statuses that still hold a service position. */
export const ACTIVE_APPOINTMENT_STATUSES = ['DRAFT', 'CONFIRMED', 'RESCHEDULED', 'CHECKED_IN', 'IN_PROGRESS'] as const;
const CUSTOMER_EDITABLE_STATUSES = ['DRAFT', 'CONFIRMED', 'RESCHEDULED'] as const;
const SOURCE_CHANNEL = 'CUSTOMER_SELF_SERVICE';
const SESSION_KIND = 'booking-session';
const SESSION_TTL = '30m';
const MS = 60_000;
const DAY_MS = 24 * 60 * MS;

export interface SiteContext {
  id: string;
  code: string;
  name: string;
  timezone: string;
  ticketCode: string | null;
}

@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);
  /** In-memory sliding window per client key (Assumption 10 — no new dependency). */
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eta: EtaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly statusHistory: StatusHistoryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Context
  // ---------------------------------------------------------------------------

  async resolveSite(): Promise<SiteContext> {
    const site = await this.prisma.site.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, name: true, timezone: true, ticketCode: true },
    });
    if (!site) throw new NotFoundException('Online booking is not available.');
    return site;
  }

  async loadRules(siteId: string): Promise<{ booking: BookingRules; eta: EtaRuleValues; hours: OperatingHoursConfig | null }> {
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

  /** Anonymous rate limit: `rateLimitPer10Min` hits per route per client key. */
  enforceRateLimit(route: string, clientKey: string, limit: number): void {
    const now = Date.now();
    const key = `${route}:${clientKey}`;
    const stamps = (this.hits.get(key) ?? []).filter((t) => t > now - 10 * MS);
    if (stamps.length >= limit) {
      throw new HttpException('Too many requests — please wait a few minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
    stamps.push(now);
    this.hits.set(key, stamps);
  }

  async getSiteInfo() {
    const site = await this.resolveSite();
    const { booking, eta } = await this.loadRules(site.id);
    return {
      siteName: site.name,
      timezone: site.timezone,
      bookingEnabled: booking.enabled,
      plannedMinutes: eta.defaultDurationMinutes,
      arrivalInstructions: booking.arrivalInstructions,
      cancelCutoffHours: booking.cancelCutoffHours,
      rescheduleCutoffHours: booking.rescheduleCutoffHours,
      advanceWindowDays: booking.advanceWindowDays,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — identify (mobile + plate)
  // ---------------------------------------------------------------------------

  async identify(dto: IdentifyDto, clientKey: string) {
    const site = await this.resolveSite();
    const { booking } = await this.loadRules(site.id);
    this.assertEnabled(booking);
    this.enforceRateLimit('identify', clientKey, booking.rateLimitPer10Min);

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { vehicleCode: vehicleCodeForPlate(dto.plateNumber) },
      select: {
        id: true,
        customer: {
          select: {
            id: true,
            firstName: true,
            phone: true,
            vehicles: { select: { id: true, plateNumber: true, make: true, model: true, modelYear: true }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });

    // Both facts must match. Anything else is "not known" — never a hint about
    // which half was wrong, and never a link to somebody else's record.
    if (!vehicle || !phoneMatches(vehicle.customer.phone, dto.phone)) {
      return { known: false as const };
    }

    const sessionToken = jwt.sign({ sub: vehicle.customer.id, kind: SESSION_KIND }, this.secret(), { expiresIn: SESSION_TTL });
    return {
      known: true as const,
      sessionToken,
      firstName: vehicle.customer.firstName,
      phoneMasked: maskPhone(vehicle.customer.phone),
      vehicles: vehicle.customer.vehicles.map((v) => ({
        id: v.id,
        plateMasked: maskPlate(v.plateNumber),
        make: v.make,
        model: v.model,
        modelYear: v.modelYear,
        matched: v.id === vehicle.id,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Step 3 — services (customer-safe projection)
  // ---------------------------------------------------------------------------

  async listServices() {
    const site = await this.resolveSite();
    const { booking, eta } = await this.loadRules(site.id);
    const types = await this.prisma.serviceType.findMany({
      where: { isActive: true, isExternal: false, code: { notIn: booking.excludedServiceCodes } },
      select: { code: true, name: true, family: true, baseDurationMinutes: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
    });
    return types.map((t) => ({
      code: t.code,
      name: t.name,
      family: t.family,
      plannedMinutes: this.plannedMinutes([t], booking, eta),
    }));
  }

  // ---------------------------------------------------------------------------
  // Step 4 — availability
  // ---------------------------------------------------------------------------

  async availability(serviceCodes: string[], from: string | undefined, days: number | undefined, clientKey: string) {
    const site = await this.resolveSite();
    const rules = await this.loadRules(site.id);
    this.assertEnabled(rules.booking);
    this.enforceRateLimit('availability', clientKey, rules.booking.rateLimitPer10Min * 3);

    const services = await this.resolveServices(serviceCodes, rules.booking);
    const now = new Date();
    const today = localDayKey(now, site.timezone);
    const first = from && from >= today ? from : today;
    const lastAllowed = addDaysToKey(today, rules.booking.advanceWindowDays);
    const count = Math.min(days ?? 14, rules.booking.advanceWindowDays + 1);

    const dayInputs: DayInput[] = [];
    for (let i = 0; i < count; i++) {
      const key = addDaysToKey(first, i);
      if (key > lastAllowed) break;
      dayInputs.push({
        dateKey: key,
        window: dayWindow(rules.hours, key, site.timezone),
        isClosedDate: rules.booking.closedDates.includes(key),
        isToday: key === today,
      });
    }
    const existing = await this.existingBookings(site.id, dayInputs, this.prisma);
    const slotRules = this.slotRules(services, rules);
    const result = computeAvailability(now, dayInputs, existing, slotRules);
    return {
      plannedMinutes: slotRules.durationMinutes,
      timezone: site.timezone,
      ...result,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 5 — confirm (transactional, locked)
  // ---------------------------------------------------------------------------

  async confirm(dto: ConfirmBookingDto, clientKey: string) {
    const site = await this.resolveSite();
    const rules = await this.loadRules(site.id);
    this.assertEnabled(rules.booking);
    this.enforceRateLimit('confirm', clientKey, rules.booking.rateLimitPer10Min);

    const services = await this.resolveServices(dto.serviceCodes, rules.booking);
    const start = this.parseSlot(dto.scheduledStartAt);
    const slotRules = this.slotRules(services, rules);
    const end = new Date(start.getTime() + slotRules.durationMinutes * MS);
    this.assertSlotAllowed(start, end, site, rules);

    // Who is booking?
    const sessionCustomerId = dto.sessionToken ? this.verifySession(dto.sessionToken) : null;
    if (!sessionCustomerId && !dto.customer) {
      throw new BadRequestException('Tell us who you are: identify with your mobile and plate, or enter your details.');
    }
    if (sessionCustomerId && dto.vehicleId == null && !dto.vehicle) {
      throw new BadRequestException('Choose one of your vehicles or add the vehicle you are booking for.');
    }
    if (!sessionCustomerId && !dto.vehicle) {
      throw new BadRequestException('Enter the vehicle you are booking for.');
    }

    const dayKey = localDayKey(start, site.timezone);
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${site.id}:${dayKey}`}))`;

      // Re-check the slot with the lock held: this is the guarantee.
      const existing = await this.existingBookings(
        site.id,
        [{ dateKey: dayKey, window: { open: start, close: end }, isClosedDate: false, isToday: false }],
        tx,
      );
      if (!isSlotAvailable(existing, start, slotRules)) {
        throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Sorry — that time was just taken. Please choose another slot.' });
      }

      // Customer
      let customerId = sessionCustomerId;
      if (!customerId) {
        const c = dto.customer!;
        const numberRows = await tx.$queryRaw<{ next_val: number }[]>`
          SELECT COALESCE(MAX(CAST(SUBSTRING(customer_number FROM 6) AS INTEGER)), 0) + 1 AS next_val
          FROM customers WHERE customer_number ~ '^CUST-[0-9]+$'`;
        const customerNumber = `CUST-${String(numberRows[0].next_val).padStart(6, '0')}`;
        const customer = await tx.customer.create({
          data: {
            customerNumber,
            firstName: c.firstName.trim(),
            lastName: c.lastName.trim(),
            phone: c.phone.trim(),
            email: c.email?.trim() || null,
            notificationOptInSms: c.smsOptIn ?? true,
            notificationOptInEmail: c.emailOptIn ?? true,
            notes: 'Created by customer self-service booking (CR-2026-105c).',
          },
          select: { id: true },
        });
        customerId = customer.id;
      }

      // Vehicle
      let vehicleId = dto.vehicleId ?? null;
      if (vehicleId) {
        const owned = await tx.vehicle.findFirst({ where: { id: vehicleId, customerId }, select: { id: true } });
        if (!owned) throw new BadRequestException('That vehicle is not on your record.');
      } else {
        const v = dto.vehicle!;
        const code = vehicleCodeForPlate(v.plateNumber);
        const found = await tx.vehicle.findUnique({ where: { vehicleCode: code }, select: { id: true, customerId: true } });
        if (found && found.customerId !== customerId) {
          throw new ConflictException({
            code: 'PLATE_IN_USE',
            message: 'That plate is already on record. Please identify with the mobile number we have for it, or contact the front desk.',
          });
        }
        if (found) {
          vehicleId = found.id;
        } else {
          const vehicle = await tx.vehicle.create({
            data: {
              customerId,
              vehicleCode: code,
              plateNumber: v.plateNumber.trim().toUpperCase(),
              make: v.make?.trim() || null,
              model: v.model?.trim() || null,
              modelYear: v.modelYear ?? null,
            },
            select: { id: true },
          });
          vehicleId = vehicle.id;
        }
      }

      // One active booking per vehicle per day (Assumption 7: refuse, never merge).
      await this.assertNoVehicleConflict(tx, site.id, vehicleId, start, end, null);

      const appointmentNumber = await allocateBookingReference(tx, site, now);
      const token = generateManageToken();
      const appt = await tx.appointment.create({
        data: {
          siteId: site.id,
          customerId,
          vehicleId,
          scheduledStartAt: start,
          scheduledEndAt: end,
          status: 'CONFIRMED',
          confirmationStatus: 'CONFIRMED',
          sourceChannel: SOURCE_CHANNEL,
          createdByUserId: null,
          appointmentNumber,
          manageTokenHash: token.hash,
          manageTokenExpiresAt: new Date(start.getTime() + rules.booking.manageTokenDaysAfter * DAY_MS),
          services: { create: services.map((s) => ({ serviceTypeId: s.id, qty: 1 })) },
        },
        include: this.appointmentInclude(),
      });
      return { appt, token: token.token };
    });

    await this.recordCreated(created.appt.id, created.appt.appointmentNumber!, 'CONFIRMED');
    await this.notify('CONFIRMED', created.appt, site, rules.booking, created.token);

    return this.confirmationView(created.appt, site, rules.booking, created.token);
  }

  // ---------------------------------------------------------------------------
  // Manage — view / cancel / reschedule
  // ---------------------------------------------------------------------------

  async manage(token: string) {
    const { appt, site, rules } = await this.loadByToken(token);
    return this.manageView(appt, site, rules.booking);
  }

  async cancelByCustomer(token: string, reason: string | undefined, clientKey: string) {
    const { appt, site, rules } = await this.loadByToken(token);
    this.enforceRateLimit('manage', clientKey, rules.booking.rateLimitPer10Min);
    const view = this.manageView(appt, site, rules.booking);
    if (!view.canCancel) {
      throw new ConflictException({ code: 'CANNOT_CANCEL', message: view.cancelBlockedReason ?? 'This appointment can no longer be cancelled online.' });
    }

    const updated = await this.prisma.appointment.update({
      where: { id: appt.id },
      data: { status: 'CANCELLED' },
      include: this.appointmentInclude(),
    });
    await this.statusHistory.record({
      entityType: 'Appointment',
      entityId: appt.id,
      fromStatus: appt.status,
      toStatus: 'CANCELLED',
      reasonCode: 'APPOINTMENT_CANCEL',
      notes: reason?.trim() ? `Cancelled by customer: ${reason.trim()}` : 'Cancelled by customer (online)',
    });
    await this.audit.log({
      actorUserId: null,
      action: AUDIT_ACTIONS.APPOINTMENT_CANCELLED_BY_CUSTOMER,
      entityType: 'Appointment',
      entityId: appt.id,
      beforeJson: { status: appt.status },
      afterJson: { status: 'CANCELLED', actorType: 'CUSTOMER', appointmentNumber: appt.appointmentNumber },
      reasonCode: 'APPOINTMENT_CANCEL',
      notes: reason?.trim() || undefined,
    });
    await this.notify('CANCELLED', updated, site, rules.booking, null);
    return this.manageView(updated, site, rules.booking);
  }

  async rescheduleByCustomer(token: string, dto: RescheduleBookingDto, clientKey: string) {
    const { appt, site, rules } = await this.loadByToken(token);
    this.enforceRateLimit('manage', clientKey, rules.booking.rateLimitPer10Min);
    // The maximum-reschedules rule needs the history count on the WRITE path too.
    (appt as AppointmentRow).reschedules = await this.rescheduleCount(appt.id);
    const view = this.manageView(appt, site, rules.booking);
    if (!view.canReschedule) {
      throw new ConflictException({ code: 'CANNOT_RESCHEDULE', message: view.rescheduleBlockedReason ?? 'This appointment can no longer be moved online.' });
    }

    const services = appt.services.map((s) => s.serviceType);
    const slotRules = this.slotRules(services, rules);
    const start = this.parseSlot(dto.scheduledStartAt);
    const end = new Date(start.getTime() + slotRules.durationMinutes * MS);
    this.assertSlotAllowed(start, end, site, rules);
    const dayKey = localDayKey(start, site.timezone);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${site.id}:${dayKey}`}))`;
      const existing = await this.existingBookings(
        site.id,
        [{ dateKey: dayKey, window: { open: start, close: end }, isClosedDate: false, isToday: false }],
        tx,
        appt.id,
      );
      if (!isSlotAvailable(existing, start, slotRules)) {
        throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Sorry — that time was just taken. Please choose another slot.' });
      }
      await this.assertNoVehicleConflict(tx, site.id, appt.vehicleId, start, end, appt.id);
      return tx.appointment.update({
        where: { id: appt.id },
        data: {
          scheduledStartAt: start,
          scheduledEndAt: end,
          status: 'RESCHEDULED',
          confirmationStatus: 'CONFIRMED',
          manageTokenExpiresAt: new Date(start.getTime() + rules.booking.manageTokenDaysAfter * DAY_MS),
        },
        include: this.appointmentInclude(),
      });
    });

    await this.statusHistory.record({
      entityType: 'Appointment',
      entityId: appt.id,
      fromStatus: appt.status,
      toStatus: 'RESCHEDULED',
      reasonCode: 'CUSTOMER_RESCHEDULE',
      notes: `Moved online from ${appt.scheduledStartAt.toISOString()} to ${start.toISOString()}`,
    });
    await this.audit.log({
      actorUserId: null,
      action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED_BY_CUSTOMER,
      entityType: 'Appointment',
      entityId: appt.id,
      beforeJson: { scheduledStartAt: appt.scheduledStartAt, status: appt.status },
      afterJson: { scheduledStartAt: start, status: 'RESCHEDULED', actorType: 'CUSTOMER', appointmentNumber: appt.appointmentNumber },
    });
    await this.notify('RESCHEDULED', updated, site, rules.booking, null);
    return this.manageView(updated, site, rules.booking);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not configured');
    return s;
  }

  private verifySession(token: string): string {
    try {
      const payload = jwt.verify(token, this.secret()) as { sub?: string; kind?: string };
      if (payload.kind !== SESSION_KIND || !payload.sub) throw new Error('kind');
      return payload.sub;
    } catch {
      throw new ForbiddenException('Your session has expired — please identify again.');
    }
  }

  private assertEnabled(rules: BookingRules): void {
    if (!rules.enabled) throw new ForbiddenException('Online booking is currently unavailable. Please call the service centre.');
  }

  private parseSlot(iso: string): Date {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid appointment time.');
    return d;
  }

  /** Public-side placement rules (min notice, advance window, closed dates, hours). */
  private assertSlotAllowed(start: Date, end: Date, site: SiteContext, rules: { booking: BookingRules; hours: OperatingHoursConfig | null }): void {
    const now = new Date();
    if (start.getTime() < now.getTime() + rules.booking.minNoticeMinutes * MS) {
      throw new BadRequestException(`Appointments need at least ${rules.booking.minNoticeMinutes} minutes' notice.`);
    }
    if (start.getTime() > now.getTime() + (rules.booking.advanceWindowDays + 1) * DAY_MS) {
      throw new BadRequestException(`Appointments can be booked up to ${rules.booking.advanceWindowDays} days ahead.`);
    }
    const dayKey = localDayKey(start, site.timezone);
    if (rules.booking.closedDates.includes(dayKey)) throw new BadRequestException('The service centre is closed on that date.');
    if (dayKey === localDayKey(now, site.timezone) && !rules.booking.sameDayAllowed) {
      throw new BadRequestException('Same-day online booking is not available. Please call the service centre.');
    }
    if (!isWindowWithinOperatingHours(start, end, rules.hours, site.timezone)) {
      throw new BadRequestException('That time is outside our opening hours.');
    }
  }

  private async resolveServices(codes: string[], rules: BookingRules) {
    const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
    if (unique.length === 0) throw new BadRequestException('Choose at least one service.');
    const types = await this.prisma.serviceType.findMany({
      where: { code: { in: unique }, isActive: true, isExternal: false },
      select: { id: true, code: true, name: true, baseDurationMinutes: true },
    });
    const missing = unique.filter((c) => !types.some((t) => t.code === c) || rules.excludedServiceCodes.includes(c));
    if (missing.length) throw new BadRequestException(`These services cannot be booked online: ${missing.join(', ')}`);
    return types;
  }

  /** Assumption 2: management's 80 minutes unless the catalogue is explicitly enabled. */
  private plannedMinutes(services: Array<{ baseDurationMinutes: number | null }>, booking: BookingRules, eta: EtaRuleValues): number {
    if (booking.durationSource === 'CATALOGUE') {
      const sum = services.reduce((s, t) => s + (t.baseDurationMinutes && t.baseDurationMinutes > 0 ? t.baseDurationMinutes : 0), 0);
      if (sum > 0) return sum;
    }
    return eta.defaultDurationMinutes;
  }

  private slotRules(services: Array<{ baseDurationMinutes: number | null }>, rules: { booking: BookingRules; eta: EtaRuleValues }): SlotRules {
    return {
      slotIntervalMinutes: rules.booking.slotIntervalMinutes,
      minNoticeMinutes: rules.booking.minNoticeMinutes,
      sameDayAllowed: rules.booking.sameDayAllowed,
      capacity: rules.eta.capacity,
      durationMinutes: this.plannedMinutes(services, rules.booking, rules.eta),
      defaultDurationMinutes: rules.eta.defaultDurationMinutes,
    };
  }

  /** Active appointments that could overlap any of the given days (± a day for safety). */
  private async existingBookings(
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

  private async assertNoVehicleConflict(
    tx: Prisma.TransactionClient,
    siteId: string,
    vehicleId: string,
    start: Date,
    end: Date,
    excludeId: string | null,
  ): Promise<void> {
    const dayStart = new Date(start.getTime() - DAY_MS);
    const dayEnd = new Date(end.getTime() + DAY_MS);
    const conflict = await tx.appointment.findFirst({
      where: {
        siteId,
        vehicleId,
        status: { in: [...ACTIVE_APPOINTMENT_STATUSES] as never[] },
        scheduledStartAt: { gte: dayStart, lte: dayEnd },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { appointmentNumber: true, scheduledStartAt: true },
    });
    if (conflict) {
      throw new ConflictException({
        code: 'ALREADY_BOOKED',
        message: 'This vehicle already has an appointment around that time. Use the link in your confirmation message to view or change it.',
        appointmentNumber: conflict.appointmentNumber,
        scheduledStartAt: conflict.scheduledStartAt,
      });
    }
  }

  private appointmentInclude() {
    return {
      services: { include: { serviceType: { select: { id: true, code: true, name: true, baseDurationMinutes: true } } } },
      customer: { select: { id: true, firstName: true, phone: true, email: true, notificationOptInSms: true, notificationOptInEmail: true } },
      vehicle: { select: { id: true, plateNumber: true, make: true, model: true, modelYear: true } },
    } satisfies Prisma.AppointmentInclude;
  }

  private async loadByToken(token: string) {
    if (!token || token.length > 200) throw new NotFoundException('This booking link is invalid or has expired.');
    const appt = await this.prisma.appointment.findFirst({
      where: { manageTokenHash: hashManageToken(token), manageTokenExpiresAt: { gt: new Date() } },
      include: this.appointmentInclude(),
    });
    if (!appt) throw new NotFoundException('This booking link is invalid or has expired.');
    const site = await this.prisma.site.findUnique({
      where: { id: appt.siteId },
      select: { id: true, code: true, name: true, timezone: true, ticketCode: true },
    });
    if (!site) throw new NotFoundException('This booking link is invalid or has expired.');
    const rules = await this.loadRules(site.id);
    return { appt, site, rules };
  }

  private async rescheduleCount(appointmentId: string): Promise<number> {
    return this.prisma.statusHistory.count({
      where: { entityType: 'Appointment', entityId: appointmentId, toStatus: 'RESCHEDULED' },
    });
  }

  private async recordCreated(id: string, appointmentNumber: string, toStatus: string): Promise<void> {
    await this.statusHistory.record({ entityType: 'Appointment', entityId: id, fromStatus: null, toStatus });
    await this.audit.log({
      actorUserId: null,
      action: AUDIT_ACTIONS.APPOINTMENT_CREATED_ONLINE,
      entityType: 'Appointment',
      entityId: id,
      afterJson: { actorType: 'CUSTOMER', appointmentNumber, sourceChannel: SOURCE_CHANNEL, status: toStatus },
    });
  }

  private manageUrl(token: string | null): string | undefined {
    if (!token) return undefined;
    const base = (process.env.API_CORS_ORIGIN ?? 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '');
    return `${base}/book/manage/${token}`;
  }

  /** NOT-001: confirmation on create and reschedule; cancellation notice too. Opt-in gated. */
  private async notify(
    kind: 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED',
    appt: AppointmentRow,
    site: SiteContext,
    booking: BookingRules,
    token: string | null,
  ): Promise<void> {
    try {
      await this.notifications.queueAppointmentMessage(kind, {
        appointmentId: appt.id,
        phone: appt.customer.notificationOptInSms ? appt.customer.phone : null,
        email: appt.customer.notificationOptInEmail ? appt.customer.email : null,
        scheduledStartAt: appt.scheduledStartAt,
        durationMinutes: this.durationOf(appt),
        services: appt.services.map((s) => s.serviceType.name),
        siteName: site.name,
        timezone: site.timezone,
        reference: appt.appointmentNumber ?? '',
        manageUrl: this.manageUrl(token),
        instructions: booking.arrivalInstructions,
      });
    } catch (err) {
      this.logger.error(`Booking notification (${kind}) failed for ${appt.id}: ${(err as Error).message}`);
    }
  }

  private durationOf(appt: AppointmentRow): number {
    return appt.scheduledEndAt ? Math.round((appt.scheduledEndAt.getTime() - appt.scheduledStartAt.getTime()) / MS) : 0;
  }

  private baseView(appt: AppointmentRow, site: SiteContext, booking: BookingRules) {
    return {
      appointmentNumber: appt.appointmentNumber,
      status: appt.status,
      scheduledStartAt: appt.scheduledStartAt.toISOString(),
      scheduledEndAt: appt.scheduledEndAt?.toISOString() ?? null,
      plannedMinutes: this.durationOf(appt),
      services: appt.services.map((s) => ({ code: s.serviceType.code, name: s.serviceType.name })),
      firstName: appt.customer.firstName,
      phoneMasked: maskPhone(appt.customer.phone),
      vehicle: {
        plateMasked: maskPlate(appt.vehicle.plateNumber),
        make: appt.vehicle.make,
        model: appt.vehicle.model,
        modelYear: appt.vehicle.modelYear,
      },
      site: { name: site.name, timezone: site.timezone },
      arrivalInstructions: booking.arrivalInstructions,
    };
  }

  private confirmationView(appt: AppointmentRow, site: SiteContext, booking: BookingRules, token: string) {
    return { ...this.baseView(appt, site, booking), manageToken: token, managePath: `/book/manage/${token}` };
  }

  private manageView(appt: AppointmentRow, site: SiteContext, booking: BookingRules) {
    const now = Date.now();
    const editable = (CUSTOMER_EDITABLE_STATUSES as readonly string[]).includes(appt.status);
    const beforeCancelCutoff = appt.scheduledStartAt.getTime() - booking.cancelCutoffHours * 60 * MS > now;
    const beforeRescheduleCutoff = appt.scheduledStartAt.getTime() - booking.rescheduleCutoffHours * 60 * MS > now;
    const reschedules = appt.reschedules ?? 0;
    const canCancel = editable && beforeCancelCutoff;
    const canReschedule = editable && beforeRescheduleCutoff && reschedules < booking.maxReschedules;
    return {
      ...this.baseView(appt, site, booking),
      canCancel,
      canReschedule,
      cancelBlockedReason: !editable
        ? `This appointment is ${appt.status.toLowerCase()} and can no longer be changed online.`
        : !beforeCancelCutoff
          ? `Online cancellation closes ${booking.cancelCutoffHours} hours before the appointment. Please call the service centre.`
          : null,
      rescheduleBlockedReason: !editable
        ? `This appointment is ${appt.status.toLowerCase()} and can no longer be changed online.`
        : !beforeRescheduleCutoff
          ? `Online rescheduling closes ${booking.rescheduleCutoffHours} hours before the appointment. Please call the service centre.`
          : reschedules >= booking.maxReschedules
            ? 'This appointment has already been moved the maximum number of times online. Please call the service centre.'
            : null,
      reschedulesUsed: reschedules,
      maxReschedules: booking.maxReschedules,
    };
  }

  /** Attach the reschedule count used by the manage view (kept off the hot confirm path). */
  async manageWithHistory(token: string) {
    const { appt, site, rules } = await this.loadByToken(token);
    (appt as AppointmentRow).reschedules = await this.rescheduleCount(appt.id);
    return this.manageView(appt, site, rules.booking);
  }
}

type AppointmentRow = Prisma.AppointmentGetPayload<{
  include: {
    services: { include: { serviceType: { select: { id: true; code: true; name: true; baseDurationMinutes: true } } } };
    customer: { select: { id: true; firstName: true; phone: true; email: true; notificationOptInSms: true; notificationOptInEmail: true } };
    vehicle: { select: { id: true; plateNumber: true; make: true; model: true; modelYear: true } };
  };
}> & { reschedules?: number };
