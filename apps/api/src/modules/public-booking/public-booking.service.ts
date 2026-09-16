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
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EtaService } from '../scheduling/eta/eta.service';
import { localDayKey } from '../../common/helpers/operating-hours';
import { phoneForStorage } from '../../common/helpers/search-terms';
import type { UatContext } from '../booking-simulator/uat-session';
import type { BookingRules } from './booking.config';
import { isSlotAvailable, type SlotRules } from './availability.engine';
import {
  BookingAvailabilityService,
  formatLatestStartLabel,
  type BookingRuleSet,
} from '../scheduling/availability/booking-availability.service';
import type { ServiceRequestDto } from './dto/public-booking.dto';
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
import { publicUrl } from '../../common/helpers/public-url';

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
    // CR-2026-106 — the ONE availability/placement engine shared with staff. Optional
    // so existing specs' five-argument construction keeps working (same logic either way).
    @Optional() private readonly availabilityService?: BookingAvailabilityService,
  ) {}

  private _avail?: BookingAvailabilityService;
  private get avail(): BookingAvailabilityService {
    if (this.availabilityService) return this.availabilityService;
    if (!this._avail) this._avail = new BookingAvailabilityService(this.prisma, this.eta);
    return this._avail;
  }

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

  async loadRules(siteId: string): Promise<BookingRuleSet> {
    return this.avail.loadRules(siteId);
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
      // CR-2026-106 — customers are never offered a start after this (server-enforced).
      latestStart: booking.customerLatestStart,
      latestStartLabel: formatLatestStartLabel(booking.customerLatestStart),
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

    const customerSelect = {
      id: true,
      firstName: true,
      phone: true,
      vehicles: { select: { id: true, plateNumber: true, make: true, model: true, modelYear: true }, orderBy: { createdAt: 'asc' as const } },
    };

    // CR-2026-106 — two identification pairs, both needing the mobile number plus a
    // second fact only the customer knows. Names are never an identity key.
    let customer: { id: string; firstName: string; phone: string; vehicles: Array<{ id: string; plateNumber: string; make: string | null; model: string | null; modelYear: number | null }> } | null = null;
    let matchedVehicleId: string | null = null;
    let identifiedBy: 'PLATE' | 'EMAIL';
    const plate = dto.plateNumber?.trim();
    const email = dto.email?.trim();
    if (plate) {
      identifiedBy = 'PLATE';
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { vehicleCode: vehicleCodeForPlate(plate) },
        select: { id: true, customer: { select: customerSelect } },
      });
      if (vehicle) {
        customer = vehicle.customer;
        matchedVehicleId = vehicle.id;
      }
    } else if (email) {
      identifiedBy = 'EMAIL';
      const rows = await this.prisma.customer.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, testDataRunId: null },
        select: customerSelect,
        take: 2,
      });
      // Exactly one record may carry the email; two means we cannot be sure — say "not known".
      customer = rows.length === 1 ? rows[0] : null;
    } else {
      throw new BadRequestException('Enter your licence plate, or the email address we have on file, together with your mobile number.');
    }

    // Both facts must match. Anything else is "not known" — never a hint about
    // which half was wrong, and never a link to somebody else's record.
    if (!customer || !phoneMatches(customer.phone, dto.phone)) {
      return { known: false as const };
    }

    const sessionToken = jwt.sign({ sub: customer.id, kind: SESSION_KIND }, this.secret(), { expiresIn: SESSION_TTL });
    return {
      known: true as const,
      identifiedBy,
      sessionToken,
      firstName: customer.firstName,
      phoneMasked: maskPhone(customer.phone),
      vehicles: customer.vehicles.map((v) => ({
        id: v.id,
        plateMasked: maskPlate(v.plateNumber),
        make: v.make,
        model: v.model,
        modelYear: v.modelYear,
        matched: v.id === matchedVehicleId,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Step 3 — services (customer-safe projection)
  // ---------------------------------------------------------------------------

  async listServices() {
    const site = await this.resolveSite();
    const { booking, eta } = await this.loadRules(site.id);
    // CR-2026-108 Stage 4A — the catalogue filter is CONFIGURATION, not code. While
    // `booking_enforce_online_bookable` is false the selection is exactly what it
    // was before this CR; when management switches it on (after the readiness audit
    // and preflight) only explicitly approved services are offered. That ordering
    // is what stops `bookableOnline` defaulting to false from emptying /book the
    // moment the migration lands.
    const types = await this.prisma.serviceType.findMany({
      where: {
        isActive: true,
        isExternal: false,
        code: { notIn: booking.excludedServiceCodes },
        ...(booking.enforceOnlineBookable ? { bookableOnline: true } : {}),
      },
      select: { code: true, name: true, customerFacingName: true, family: true, baseDurationMinutes: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
    });
    return types.map((t) => ({
      code: t.code,
      // CR-2026-108 — internal terminology stays internal where a customer-facing
      // name has been given; otherwise nothing changes.
      name: t.customerFacingName?.trim() || t.name,
      family: t.family,
      // The duration a CUSTOMER is quoted: the service itself, never the workshop
      // turnaround buffer, which is scheduling occupancy and not repair time.
      plannedMinutes: this.avail.plannedMinutes([t], { booking, eta, hours: null }),
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
    // CR-2026-106 — the SAME engine and rules the staff wizard uses, with the
    // customer audience (min notice, advance window, closed dates, latest start).
    return this.avail.availability(site, services, { from, days, audience: 'CUSTOMER', rules });
  }

  // ---------------------------------------------------------------------------
  // Step 5 — confirm (transactional, locked)
  // ---------------------------------------------------------------------------

  async confirm(dto: ConfirmBookingDto, clientKey: string, uatContext: UatContext | null = null) {
    const site = await this.resolveSite();
    const rules = await this.loadRules(site.id);
    this.assertEnabled(rules.booking);
    this.enforceRateLimit('confirm', clientKey, rules.booking.rateLimitPer10Min);

    const services = await this.resolveServices(dto.serviceCodes, rules.booking);
    const start = this.parseSlot(dto.scheduledStartAt);
    const slotRules = this.avail.slotRules(services, rules, 'CUSTOMER');
    const end = new Date(start.getTime() + slotRules.durationMinutes * MS);
    this.avail.assertSlotAllowed(start, end, site, rules, 'CUSTOMER');
    const serviceRequest = normaliseServiceRequest(dto.serviceRequest);

    // CR-2026-108 Stage 3 — the UAT context comes from the HttpOnly session cookie
    // the controller resolved, never from this request body. An invalid or expired
    // attempt is refused UPSTREAM at redemption rather than downgraded here: a
    // tester who believes UAT is active must never silently create a real customer
    // and send them a real message.
    const uat: UatContext | null = uatContext;

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

    let identityFlag: { customerId: string; possibleDuplicateOfId: string; matchedOn: string } | null = null;
    const created = await this.prisma.$transaction(async (tx) => {
      // CR-2026-106 — the same per-site-per-day lock every writer (staff too) takes.
      await this.avail.lockDay(tx, site.id, dayKey);

      // Re-check the slot with the lock held: this is the guarantee.
      const existing = await this.avail.existingBookings(
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
        const phone = phoneForStorage(c.phone);
        // CR-2026-106 — pending identity: if this mobile number already belongs to a
        // record, the new customer is FLAGGED for review (never silently merged, never
        // linked to the other record's data).
        const sameEmail = c.email?.trim();
        const possibleDuplicate = await tx.customer.findFirst({
          where: {
            testDataRunId: null,
            OR: [{ phone }, ...(sameEmail ? [{ email: { equals: sameEmail, mode: 'insensitive' as const } }] : [])],
          },
          select: { id: true, phone: true },
        });
        const customer = await tx.customer.create({
          data: {
            customerNumber,
            firstName: c.firstName.trim(),
            lastName: c.lastName.trim(),
            phone,
            email: sameEmail || null,
            notificationOptInSms: c.smsOptIn ?? true,
            notificationOptInEmail: c.emailOptIn ?? true,
            notes: 'Created by customer self-service booking (CR-2026-105c).',
            ...(possibleDuplicate ? { identityReviewStatus: 'PENDING_REVIEW', possibleDuplicateOfId: possibleDuplicate.id } : {}),
            // CR-2026-108 — created inside a UAT session: tagged to the run, so its
            // notifications are captured and cleanup can remove it.
            ...(uat ? { testDataRunId: uat.testDataRunId } : {}),
          },
          select: { id: true },
        });
        customerId = customer.id;
        if (possibleDuplicate) {
          identityFlag = { customerId, possibleDuplicateOfId: possibleDuplicate.id, matchedOn: possibleDuplicate.phone === phone ? 'PHONE' : 'EMAIL' };
        }
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
              // CR-2026-108 — created inside a UAT session: tagged to the run, so
              // its notifications are captured and cleanup can remove it.
              ...(uat ? { testDataRunId: uat.testDataRunId } : {}),
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
          // CR-2026-106 — what the customer told us, for Job Sheet preparation.
          notes: serviceRequest.notes,
          customerReportedMileage: serviceRequest.mileage,
          services: { create: services.map((s) => ({ serviceTypeId: s.id, qty: 1, requestedNotes: serviceRequest.requestedNotes })) },
        },
        include: this.appointmentInclude(),
      });
      return { appt, token: token.token };
    });

    await this.recordCreated(created.appt.id, created.appt.appointmentNumber!, 'CONFIRMED');
    if (identityFlag) {
      const flag = identityFlag as { customerId: string; possibleDuplicateOfId: string; matchedOn: string };
      await this.audit.log({
        actorUserId: null,
        action: AUDIT_ACTIONS.CUSTOMER_IDENTITY_REVIEW_FLAGGED,
        entityType: 'Customer',
        entityId: flag.customerId,
        afterJson: { possibleDuplicateOfId: flag.possibleDuplicateOfId, matchedOn: flag.matchedOn, appointmentId: created.appt.id, actorType: 'CUSTOMER' },
      });
    }
    await this.notify('CONFIRMED', created.appt, site, rules.booking, created.token, uat);

    return { ...this.confirmationView(created.appt, site, rules.booking, created.token), serviceRequest: serviceRequest.view };
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
    const slotRules = this.avail.slotRules(services, rules, 'CUSTOMER');
    const start = this.parseSlot(dto.scheduledStartAt);
    const end = new Date(start.getTime() + slotRules.durationMinutes * MS);
    this.avail.assertSlotAllowed(start, end, site, rules, 'CUSTOMER');
    const dayKey = localDayKey(start, site.timezone);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.avail.lockDay(tx, site.id, dayKey);
      const existing = await this.avail.existingBookings(
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

  /**
   * Resolve service codes for a NEW customer booking.
   *
   * CR-2026-108 Stage 4E — when `booking_enforce_online_bookable` is on this also
   * requires `bookableOnline`. Filtering only the service LIST would have made
   * enforcement cosmetic: the page would stop offering a diagnostic while the API
   * still accepted one posted directly.
   *
   * Called only from `availability` and `confirm` — both new-booking paths. A
   * RESCHEDULE reads its services from the appointment itself and never comes
   * through here, so an existing booking for a service that is no longer publicly
   * offered can still be moved. That is deliberate: `bookableOnline = false` means
   * "a customer cannot START a new booking for this", not "this appointment is
   * now stuck".
   */
  private async resolveServices(codes: string[], rules: BookingRules) {
    const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
    if (unique.length === 0) throw new BadRequestException('Choose at least one service.');
    const types = await this.prisma.serviceType.findMany({
      where: {
        code: { in: unique },
        isActive: true,
        isExternal: false,
        ...(rules.enforceOnlineBookable ? { bookableOnline: true } : {}),
      },
      select: { id: true, code: true, name: true, customerFacingName: true, baseDurationMinutes: true },
    });
    const missing = unique.filter((c) => !types.some((t) => t.code === c) || rules.excludedServiceCodes.includes(c));
    if (missing.length) throw new BadRequestException(`These services cannot be booked online: ${missing.join(', ')}`);
    return types;
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
    // CR-2026-106 — from the ONE public base (docs/121 §C4), never a CORS stand-in.
    return publicUrl(`/book/manage/${token}`);
  }

  /** NOT-001: confirmation on create and reschedule; cancellation notice too. Opt-in gated. */
  private async notify(
    kind: 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED',
    appt: AppointmentRow,
    site: SiteContext,
    booking: BookingRules,
    token: string | null,
    // CR-2026-108 Stage 3 — carried explicitly so a brand-new UAT customer's
    // confirmation is captured on the FIRST message, rather than depending on a
    // lookup rediscovering a tag written moments earlier in the same request.
    uat?: { testDataRunId: string; runLabel: string } | null,
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
        // CR-2026-106 — the customer must know WHICH car the confirmation is for.
        vehicle: `${[appt.vehicle.make, appt.vehicle.model].filter(Boolean).join(' ') || 'Vehicle'} · plate ${maskPlate(appt.vehicle.plateNumber)}`,
        customerId: appt.customer.id,
        vehicleId: appt.vehicle.id,
        ...(uat ? { testContext: { testDataRunId: uat.testDataRunId, runLabel: uat.runLabel } } : {}),
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
    return { ...this.baseView(appt, site, booking), manageToken: token, managePath: `/book/manage/${token}`, manageUrl: this.manageUrl(token) };
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

/**
 * CR-2026-106 — fold the customer's service-request answers into what the
 * appointment stores: `notes` (visible on the appointment and copied to the visit
 * as the CUSTOMER_CONCERN note at check-in), `requestedNotes` per service, and the
 * reported mileage. Pure; trims and drops empties.
 */
export function normaliseServiceRequest(sr: ServiceRequestDto | undefined | null): {
  notes: string | null;
  requestedNotes: string | undefined;
  mileage: number | null;
  view: { reasonForVisit: string | null; concern: string | null; description: string | null; mileage: number | null } | null;
} {
  const reason = sr?.reasonForVisit?.trim() || null;
  const concern = sr?.concern?.trim() || null;
  const description = sr?.description?.trim() || null;
  const mileage = typeof sr?.mileage === 'number' && Number.isFinite(sr.mileage) && sr.mileage >= 0 ? Math.round(sr.mileage) : null;
  if (!reason && !concern && !description && mileage === null) return { notes: null, requestedNotes: undefined, mileage: null, view: null };
  const lines: string[] = [];
  if (reason) lines.push(`Reason for visit: ${reason}`);
  if (concern) lines.push(`Customer concern: ${concern}`);
  if (description) lines.push(`Details: ${description}`);
  if (mileage !== null) lines.push(`Reported mileage: ${mileage.toLocaleString('en-US')}`);
  return {
    notes: `[Customer booking] ${lines.join(' | ')}`,
    requestedNotes: [reason, concern].filter(Boolean).join(' — ') || undefined,
    mileage,
    view: { reasonForVisit: reason, concern, description, mileage },
  };
}

type AppointmentRow = Prisma.AppointmentGetPayload<{
  include: {
    services: { include: { serviceType: { select: { id: true; code: true; name: true; baseDurationMinutes: true } } } };
    customer: { select: { id: true; firstName: true; phone: true; email: true; notificationOptInSms: true; notificationOptInEmail: true } };
    vehicle: { select: { id: true; plateNumber: true; make: true; model: true; modelYear: true } };
  };
}> & { reschedules?: number };
