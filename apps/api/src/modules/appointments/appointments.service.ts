import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { EtaService } from '../scheduling/eta/eta.service';
import { BOOKING_RULE_KEYS, bookingRulesFromRows } from '../public-booking/booking.config';
import { maxConcurrentOverlap, type SlotRules } from '../public-booking/availability.engine';
import {
  BookingAvailabilityService,
  catalogueMinutesFor,
  SERVICE_DURATION_SELECT,
  variesByVehicleClass,
  type BookingRuleSet,
  type VehicleClass,
} from '../scheduling/availability/booking-availability.service';

import { NotificationsService } from '../notifications/notifications.service';
import { localDayKey } from '../../common/helpers/operating-hours';
import { publicUrl } from '../../common/helpers/public-url';
import { normalizePhone } from '../../common/helpers/search-terms';
import { maskPlate } from '../public-booking/booking-reference';
import type { Prisma } from '@prisma/client';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { toZonedTime } from 'date-fns-tz';
import { getDay, getHours, getMinutes, startOfDay, isBefore, isSameDay } from 'date-fns';

/**
 * CR-2026-111b — a service as the staff paths carry it: the shared duration shape
 * plus the id they need to write AppointmentService rows. The duration fields are
 * required, so a query that forgets them does not compile.
 */
interface StaffMeasurableService {
  id: string;
  code: string;
  baseDurationMinutes: number | null;
  sedanDurationMinutes: number | null;
  suvDurationMinutes: number | null;
}

/**
 * Expected shape of the operating_hours BusinessRuleConfig value_json.
 *
 * Example:
 * {
 *   "timezone": "America/Jamaica",
 *   "schedule": {
 *     "1": { "open": "07:30", "close": "17:00" },
 *     "2": { "open": "07:30", "close": "17:00" },
 *     ...
 *     "6": { "open": "08:00", "close": "13:00" }
 *   }
 * }
 *
 * Days follow JS getDay(): 0 = Sunday, 1 = Monday, ... 6 = Saturday.
 * A missing day key means the site is closed on that day.
 */
interface OperatingHoursSchedule {
  timezone?: string;
  schedule: Record<
    string,
    { open: string; close: string } | undefined
  >;
}

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private prisma: PrismaService,
    private statusHistory: StatusHistoryService,
    private auditService: AuditService,
    // CR-2026-105c — workshop capacity for the warn-not-block check. Optional so the
    // existing specs' three-argument construction keeps working (check skipped).
    @Optional() private eta?: EtaService,
    // CR-2026-106 — the ONE availability/placement engine shared with the public
    // booking page (duration, capacity, day lock, latest start). Optional for the
    // same reason; when present it replaces the pre-check below.
    @Optional() private availability?: BookingAvailabilityService,
    // CR-2026-106 — a staff cancel/reschedule of an ONLINE booking tells the customer.
    @Optional() private notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // CR-2026-106 — staff availability: the same slots a customer would see, with
  // the STAFF audience (no minimum notice, any open day, latest start only when
  // enforced for staff). Used by the appointment wizard's Date/Time steps.
  // ---------------------------------------------------------------------------

  async staffAvailability(
    siteId: string,
    serviceCodes: string[],
    from?: string,
    days?: number,
    excludeAppointmentId?: string,
    vehicleId?: string,
  ) {
    if (!this.availability) throw new BadRequestException('Availability engine is not configured.');
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true, timezone: true } });
    if (!site) throw new NotFoundException(`Site ${siteId} not found`);
    const codes = [...new Set(serviceCodes.map((c) => c.trim()).filter(Boolean))];
    const services = codes.length ? [...(await this.resolveServiceTypeCodes(codes)).values()] : [];
    // CR-2026-111b — when the wizard already knows the vehicle, the slots an
    // advisor is shown are the length that vehicle actually needs. Without it the
    // advisor would be offered a slot the booking then refuses to fit into.
    const vehicleClass = await this.resolveVehicleClass(vehicleId, services);
    return this.availability.availability(site, services, {
      from,
      days,
      audience: 'STAFF',
      excludeAppointmentId: excludeAppointmentId ?? null,
      vehicleClass,
    });
  }

  /**
   * CR-2026-111b — the vehicle's service class, from the ONE shared engine.
   *
   * Delegates rather than querying, so staff and customer paths cannot drift apart
   * again.
   *
   * The lookup is skipped when NO service being booked varies by class, which is
   * most of the catalogue: the class cannot change the answer, so asking the
   * database for it would be a query whose result is discarded.
   */
  private async resolveVehicleClass(
    vehicleId: string | null | undefined,
    services: Array<{ sedanDurationMinutes: number | null; suvDurationMinutes: number | null }>,
  ): Promise<VehicleClass> {
    if (!this.availability || !vehicleId) return null;
    if (!services.some(variesByVehicleClass)) return null;
    return this.availability.vehicleClassOf(vehicleId);
  }

  /**
   * CR-2026-106 — the public booking link plus the message staff send with it
   * (WhatsApp Phase 1 = a message containing the secure booking URL).
   */
  async bookingLink(siteId: string, phone?: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true, name: true } });
    if (!site) throw new NotFoundException(`Site ${siteId} not found`);
    const bookingUrl = publicUrl('/book');
    const template = this.availability ? (await this.availability.loadRules(siteId)).booking.shareMessageTemplate : 'Book your next service online: {bookingUrl}';
    const message = template.replace(/\{bookingUrl\}/g, bookingUrl).replace(/\{siteName\}/g, site.name);
    const digits = phone ? normalizePhone(phone) : '';
    // Jamaican numbers: 7 local digits → +1 876; 10 digits → +1; 11 starting with 1 → as is.
    const e164 = digits.length === 7 ? `1876${digits}` : digits.length === 10 ? `1${digits}` : digits.length === 11 && digits.startsWith('1') ? digits : digits;
    const text = encodeURIComponent(message);
    return {
      bookingUrl,
      message,
      whatsappUrl: e164 ? `https://wa.me/${e164}?text=${text}` : `https://wa.me/?text=${text}`,
      smsUrl: e164 ? `sms:+${e164}?body=${text}` : `sms:?body=${text}`,
    };
  }

  /** Loads the shared rule set + site context when the shared engine is wired; null otherwise. */
  private async staffPlacementContext(siteId: string): Promise<{ rules: BookingRuleSet; site: { id: string; timezone: string } } | null> {
    if (!this.availability) return null;
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true, timezone: true } });
    if (!site) return null;
    return { rules: await this.availability.loadRules(siteId), site };
  }

  /**
   * CR-2026-106 — inside the writer's transaction: take the per-site-per-day lock and
   * re-check capacity with it held (the same guarantee the public confirm has).
   * Warn-not-block for staff: 409 CAPACITY_FULL unless acknowledged (then audited).
   */
  private async guardStaffSlot(
    tx: Prisma.TransactionClient,
    ctx: { rules: BookingRuleSet; site: { id: string; timezone: string } },
    start: Date,
    slotRules: SlotRules,
    acknowledged: boolean,
    excludeAppointmentId: string | null,
  ): Promise<{ overbooked: boolean; capacity: number; booked: number }> {
    await this.availability!.lockDay(tx, ctx.site.id, localDayKey(start, ctx.site.timezone));
    const check = await this.availability!.slotStillAvailable(tx, ctx.site.id, start, slotRules, excludeAppointmentId);
    if (check.available) return { overbooked: false, capacity: check.capacity, booked: check.booked };
    if (ctx.rules.booking.staffCapacityWarning && !acknowledged) {
      throw new ConflictException({
        code: 'CAPACITY_FULL',
        message: `All ${check.capacity} service position(s) are already booked for this time (${check.booked} appointment(s) overlap). Choose another time, or continue to book past capacity — this will be recorded.`,
        capacity: check.capacity,
        booked: check.booked,
      });
    }
    return { overbooked: true, capacity: check.capacity, booked: check.booked };
  }

  /** CR-2026-106 — tell the customer when STAFF change an online booking. */
  private async notifyOnlineBookingChange(kind: 'RESCHEDULED' | 'CANCELLED', appt: { id: string; sourceChannel: string | null; appointmentNumber: string | null; scheduledStartAt: Date; scheduledEndAt: Date | null; customer: { firstName?: string; phone: string; email: string | null; notificationOptInEmail: boolean }; vehicle: { plateNumber: string; make: string | null; model: string | null }; site: { name: string; timezone: string | null }; services: Array<{ serviceType: { name: string } }> }, userId: string) {
    if (appt.sourceChannel !== 'CUSTOMER_SELF_SERVICE' || !this.notifications) return;
    try {
      // CR-2026-112 — email only. No address means no message, and the audit
      // below records that plainly instead of claiming a send.
      // CR-2026-113 — a change the SERVICE CENTRE made to this customer's own
      // booking is operational, so it is not gated on a marketing preference.
      // Without this, telling someone we moved their appointment would have
      // needed a manager to override their preference.
      await this.notifications.queueAppointmentMessage(kind, {
        appointmentId: appt.id,
        email: appt.customer.email,
        customerFirstName: appt.customer.firstName ?? null,
        scheduledStartAt: appt.scheduledStartAt,
        durationMinutes: appt.scheduledEndAt ? Math.round((appt.scheduledEndAt.getTime() - appt.scheduledStartAt.getTime()) / 60_000) : 0,
        services: appt.services.map((s) => s.serviceType.name),
        siteName: appt.site.name,
        timezone: appt.site.timezone ?? undefined,
        reference: appt.appointmentNumber ?? '',
        vehicle: `${[appt.vehicle.make, appt.vehicle.model].filter(Boolean).join(' ') || 'Vehicle'} · plate ${maskPlate(appt.vehicle.plateNumber)}`,
        changeGuidance: kind === 'RESCHEDULED' ? 'This change was made by the service centre. If the new time does not suit you, please call us.' : undefined,
        customerId: (appt as { customerId?: string }).customerId ?? null,
        vehicleId: (appt as { vehicleId?: string }).vehicleId ?? null,
      });
      await this.auditService.log({
        actorUserId: userId,
        action: kind === 'RESCHEDULED' ? AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED_BY_STAFF : AUDIT_ACTIONS.APPOINTMENT_CANCELLED_BY_STAFF,
        entityType: 'Appointment',
        entityId: appt.id,
        afterJson: {
          appointmentNumber: appt.appointmentNumber,
          // CR-2026-112 — the truth, not an assumption: a customer with no email
          // address (or no email consent) was NOT notified.
          customerNotified: !!appt.customer.email,
          notifiedBy: 'EMAIL',
          scheduledStartAt: appt.scheduledStartAt,
        },
      });
    } catch (err) {
      this.logger.error(`Online-booking ${kind} notification failed for ${appt.id}: ${(err as Error).message}`);
    }
  }

  /**
   * CR-2026-105c (Assumption 11) — staff bookings consume the same constrained
   * capacity the public engine offers. If every service position is already
   * booked for the window, refuse with 409 CAPACITY_FULL unless the advisor
   * acknowledges the overbooking, which is then audited. Warn-not-block, mirroring
   * the technician-workload precedent (docs/114).
   */
  private async checkStaffCapacity(
    siteId: string,
    start: Date,
    end: Date,
    acknowledged: boolean,
  ): Promise<{ overbooked: boolean; capacity: number; booked: number }> {
    if (!this.eta) return { overbooked: false, capacity: 0, booked: 0 };
    const rows = await this.prisma.businessRuleConfig.findMany({
      where: { ruleKey: { in: [...BOOKING_RULE_KEYS] }, effectiveTo: null, OR: [{ siteId }, { siteId: null }] },
      select: { ruleKey: true, valueJson: true, siteId: true },
    });
    const booking = bookingRulesFromRows(rows);
    if (!booking.staffCapacityWarning) return { overbooked: false, capacity: 0, booked: 0 };
    const etaRules = await this.eta.loadRules(siteId);
    const existing = await this.prisma.appointment.findMany({
      where: {
        siteId,
        status: { in: ['DRAFT', 'CONFIRMED', 'RESCHEDULED', 'CHECKED_IN', 'IN_PROGRESS'] },
        scheduledStartAt: { gte: new Date(start.getTime() - 24 * 60 * 60_000), lte: new Date(end.getTime() + 24 * 60 * 60_000) },
      },
      select: { scheduledStartAt: true, scheduledEndAt: true },
    });
    const booked = maxConcurrentOverlap(
      existing.map((a) => ({ startAt: a.scheduledStartAt, endAt: a.scheduledEndAt })),
      start,
      end,
      etaRules.defaultDurationMinutes,
    );
    const overbooked = booked >= Math.max(1, etaRules.capacity);
    if (overbooked && !acknowledged) {
      throw new ConflictException({
        code: 'CAPACITY_FULL',
        message: `All ${etaRules.capacity} service position(s) are already booked for this time (${booked} appointment(s) overlap). Choose another time, or continue to book past capacity — this will be recorded.`,
        capacity: etaRules.capacity,
        booked,
      });
    }
    return { overbooked, capacity: etaRules.capacity, booked };
  }

  // ---------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------

  async create(data: CreateAppointmentDto, userId: string) {
    const scheduledStartAt = new Date(data.scheduledStartAt);

    // 1. Validate: scheduledStartAt must be in the future
    if (isBefore(scheduledStartAt, new Date())) {
      throw new BadRequestException(
        'Scheduled start time must be in the future (a later time today is allowed).',
      );
    }

    // 1b. DMAIC Rule 1 (same-day cutoff) RELAXED per CR-2026-041 (owner-approved):
    // any future slot within business hours is bookable same-day with no manager
    // override. The enforceSameDayCutoff() method + its tests are retained (unused)
    // so the rule can be re-enabled by restoring this call.
    // await this.enforceSameDayCutoff(scheduledStartAt, data.siteId, !!(data as any).managerOverride, userId);

    // 2. Validate: within operating hours
    await this.validateOperatingHours(scheduledStartAt, data.siteId);

    // 3. Resolve service type IDs from codes
    const serviceTypeMap = await this.resolveServiceTypeCodes(
      data.serviceTypes.map((s) => s.serviceTypeCode),
    );

    // 4. Check for same-day merge opportunity (SCH-004)
    const existingAppointment = await this.findSameDayAppointment(
      data.customerId,
      data.vehicleId,
      data.siteId,
      scheduledStartAt,
    );

    if (existingAppointment) {
      return this.mergeServicesIntoExisting(
        existingAppointment.id,
        data.serviceTypes,
        serviceTypeMap,
        userId,
      );
    }

    // 5. Planned duration. CR-2026-106 — from the SAME rule the public engine uses
    // (appointment_duration_source: DEFAULT = the flat default, CATALOGUE =
    // catalogue sum); the legacy catalogue sum remains only when the shared engine
    // is not wired (unit specs).
    //
    // CR-2026-111b — and from the same VEHICLE. An advisor booking an SUV general
    // service must get the same 120 minutes the customer would get booking it
    // themselves; the channel the appointment came through is not an input to how
    // long the work takes (§4).
    const ctx = await this.staffPlacementContext(data.siteId);
    const selectedServices = data.serviceTypes.map((s) => serviceTypeMap.get(s.serviceTypeCode)!).filter(Boolean);
    const vehicleClass = await this.resolveVehicleClass(data.vehicleId, selectedServices);
    const totalDurationMinutes = ctx
      ? this.availability!.plannedMinutes(selectedServices, ctx.rules, vehicleClass)
      : data.serviceTypes.reduce((sum, s) => {
          const st = serviceTypeMap.get(s.serviceTypeCode);
          // Still the shared class rule — a second copy of it here is exactly what
          // this change set out to remove.
          return sum + (st ? catalogueMinutesFor(st, vehicleClass) : 0) * (s.qty ?? 1);
        }, 0);

    const scheduledEndAt = new Date(
      scheduledStartAt.getTime() + totalDurationMinutes * 60 * 1000,
    );

    // 5a. CR-2026-106 — latest-start rule for STAFF (only when enforced; explicit,
    // audited override).
    const placement = ctx
      ? this.availability!.assertSlotAllowed(scheduledStartAt, scheduledEndAt, ctx.site, ctx.rules, 'STAFF', { overrideLatestStart: data.overrideLatestStart === true })
      : { latestStartOverridden: false };
    const slotRules = ctx ? this.availability!.slotRules(selectedServices, ctx.rules, 'STAFF', vehicleClass) : null;

    // 5b. P4(a): reject an overlapping active appointment for the SAME vehicle.
    await this.validateNoVehicleOverlap(
      data.vehicleId,
      data.siteId,
      scheduledStartAt,
      scheduledEndAt,
    );

    // 5c. CR-2026-105c — workshop capacity (warn-not-block, audited when overridden).
    // CR-2026-106 — with the shared engine wired, the check moves INSIDE the
    // transaction under the day lock (see 6) so two writers cannot both take the
    // last position; the pre-check remains for the legacy (unwired) path.
    let capacity = ctx
      ? { overbooked: false, capacity: 0, booked: 0 }
      : await this.checkStaffCapacity(
          data.siteId,
          scheduledStartAt,
          scheduledEndAt,
          data.acknowledgeCapacity === true,
        );

    // 6. Create appointment + appointment_services in a transaction
    const appointment = await this.prisma.$transaction(async (tx) => {
      if (ctx && slotRules) {
        capacity = await this.guardStaffSlot(tx, ctx, scheduledStartAt, slotRules, data.acknowledgeCapacity === true, null);
      }
      const appt = await tx.appointment.create({
        data: {
          siteId: data.siteId,
          customerId: data.customerId,
          vehicleId: data.vehicleId,
          scheduledStartAt,
          scheduledEndAt,
          status: 'DRAFT',
          notes: data.notes,
          createdByUserId: userId,
          services: {
            create: data.serviceTypes.map((s) => ({
              serviceTypeId: serviceTypeMap.get(s.serviceTypeCode)!.id,
              qty: s.qty ?? 1,
              requestedNotes: s.notes,
            })),
          },
        },
        include: {
          services: { include: { serviceType: true } },
          customer: true,
          vehicle: true,
          site: true,
        },
      });

      return appt;
    });

    // 7. Record status history: null → DRAFT
    await this.statusHistory.record({
      entityType: 'Appointment',
      entityId: appointment.id,
      fromStatus: null,
      toStatus: 'DRAFT',
      changedByUserId: userId,
    });

    // 7b. CR-2026-105c — an acknowledged overbooking is an auditable decision.
    if (capacity.overbooked) {
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.APPOINTMENT_CAPACITY_ACKNOWLEDGED,
        entityType: 'Appointment',
        entityId: appointment.id,
        afterJson: { capacity: capacity.capacity, booked: capacity.booked, scheduledStartAt },
        reasonCode: 'CAPACITY_FULL',
      });
    }
    // 7c. CR-2026-106 — booking after the latest-start rule is an auditable decision.
    if (placement.latestStartOverridden) {
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.APPOINTMENT_LATEST_START_OVERRIDDEN,
        entityType: 'Appointment',
        entityId: appointment.id,
        afterJson: { scheduledStartAt, latestStart: ctx?.rules.booking.customerLatestStart ?? null },
        reasonCode: 'AFTER_LATEST_START',
      });
    }

    // 8. Placeholder: queue notification job for appointment confirmation
    this.logger.log(
      `[NOTIFICATION_PLACEHOLDER] Appointment ${appointment.id} created — queue confirmation notification`,
    );

    return appointment;
  }

  // ---------------------------------------------------------------------------
  // FIND BY SITE
  // ---------------------------------------------------------------------------

  async findBySite(
    siteId: string,
    filters: { date?: string; status?: string; customerId?: string },
  ) {
    const where: Record<string, unknown> = { siteId };

    if (filters.date) {
      const dayStart = new Date(filters.date);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      where.scheduledStartAt = { gte: dayStart, lt: dayEnd };
    }

    if (filters.status) {
      where.status = filters.status;
    }

    // CR-2026-084 — the check-in screen needs THIS customer's appointments. It used
    // to request the whole site's day and filter only by status, so after selecting
    // a customer the staff member was shown every active booking at the site, each
    // with its own live "Check In" button — a real risk of checking in the wrong car.
    if (filters.customerId) {
      where.customerId = filters.customerId;
    }

    return this.prisma.appointment.findMany({
      where,
      orderBy: { scheduledStartAt: 'asc' },
      include: {
        services: { include: { serviceType: true } },
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        vehicle: { select: { id: true, plateNumber: true, make: true, model: true, modelYear: true } },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // FIND BY ID
  // ---------------------------------------------------------------------------

  async findById(id: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: {
        services: { include: { serviceType: true } },
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException(`Appointment ${id} not found`);
    }

    return appointment;
  }

  // ---------------------------------------------------------------------------
  // UPDATE (reschedule / edit services)
  // ---------------------------------------------------------------------------

  async update(id: string, data: UpdateAppointmentDto, userId: string) {
    const existing = await this.findById(id);

    if (['CANCELLED', 'COMPLETED', 'CHECKED_IN', 'IN_PROGRESS'].includes(existing.status)) {
      throw new BadRequestException(
        `Cannot update appointment in status ${existing.status}`,
      );
    }

    const updateData: Record<string, unknown> = {};
    // CR-2026-106 — shared placement context for reschedules (null when unwired).
    const rescheduleCtx = data.scheduledStartAt ? await this.staffPlacementContext(existing.siteId) : null;
    // CR-2026-111b — Defect B: a reschedule must not change how long the work takes.
    // The vehicle is the same vehicle, so its class is resolved here and used for
    // every duration below; without it an SUV general service would quietly shrink
    // from 120 minutes back to 90 the moment anyone moved the appointment.
    const rescheduleVehicleClass = await this.resolveVehicleClass(
      existing.vehicleId,
      existing.services.map((s) => s.serviceType),
    );
    let latestStartOverridden = false;

    // Handle reschedule
    if (data.scheduledStartAt) {
      const newStart = new Date(data.scheduledStartAt);

      if (isBefore(newStart, new Date())) {
        throw new BadRequestException(
          'Scheduled start time must be in the future (a later time today is allowed).',
        );
      }

      await this.validateOperatingHours(newStart, existing.siteId);
      updateData.scheduledStartAt = newStart;

      // Recalculate end time if service types not changing
      if (!data.serviceTypes) {
        const services = existing.services;
        // CR-2026-106 — same duration rule as create/public when the engine is wired.
        const totalDuration = rescheduleCtx
          ? this.availability!.plannedMinutes(services.map((s) => s.serviceType), rescheduleCtx.rules, rescheduleVehicleClass)
          : services.reduce((sum, s) => sum + catalogueMinutesFor(s.serviceType, rescheduleVehicleClass) * s.qty, 0);
        updateData.scheduledEndAt = new Date(
          newStart.getTime() + totalDuration * 60 * 1000,
        );
      }
    }

    if (data.notes !== undefined) {
      updateData.notes = data.notes;
    }

    // Handle service type replacement
    if (data.serviceTypes) {
      const serviceTypeMap = await this.resolveServiceTypeCodes(
        data.serviceTypes.map((s) => s.serviceTypeCode),
      );

      const baseStart = data.scheduledStartAt
        ? new Date(data.scheduledStartAt)
        : existing.scheduledStartAt;

      // CR-2026-111c — changing the services on an appointment recomputes its end,
      // and that recomputation must honour the vehicle class like every other
      // duration path. Editing an SUV general service must not shrink it to 90.
      const totalDuration = data.serviceTypes.reduce((sum, s) => {
        const st = serviceTypeMap.get(s.serviceTypeCode);
        return sum + (st ? catalogueMinutesFor(st, rescheduleVehicleClass) : 0) * (s.qty ?? 1);
      }, 0);

      updateData.scheduledEndAt = new Date(
        baseStart.getTime() + totalDuration * 60 * 1000,
      );

      // P4(a): the time window changed — re-check same-vehicle overlap (exclude self).
      await this.validateNoVehicleOverlap(
        existing.vehicleId,
        existing.siteId,
        baseStart,
        updateData.scheduledEndAt as Date,
        id,
      );

      // CR-2026-106 — latest-start rule + day lock/capacity when the time moved.
      const newServices = data.serviceTypes.map((s) => serviceTypeMap.get(s.serviceTypeCode)!).filter(Boolean);
      if (rescheduleCtx && data.scheduledStartAt) {
        latestStartOverridden = this.availability!.assertSlotAllowed(baseStart, updateData.scheduledEndAt as Date, rescheduleCtx.site, rescheduleCtx.rules, 'STAFF', { overrideLatestStart: data.overrideLatestStart === true }).latestStartOverridden;
      }
      let capacityOutcome: { overbooked: boolean; capacity: number; booked: number } | null = null;

      // Delete existing services and create new ones inside transaction
      const appointment = await this.prisma.$transaction(async (tx) => {
        if (rescheduleCtx && data.scheduledStartAt) {
          capacityOutcome = await this.guardStaffSlot(tx, rescheduleCtx, baseStart, this.availability!.slotRules(newServices, rescheduleCtx.rules, 'STAFF', rescheduleVehicleClass), data.acknowledgeCapacity === true, id);
        }
        await tx.appointmentService.deleteMany({
          where: { appointmentId: id },
        });

        return tx.appointment.update({
          where: { id },
          data: {
            ...updateData,
            status: 'RESCHEDULED',
            services: {
              create: data.serviceTypes!.map((s) => ({
                serviceTypeId: serviceTypeMap.get(s.serviceTypeCode)!.id,
                qty: s.qty ?? 1,
                requestedNotes: s.notes,
              })),
            },
          },
          include: {
            services: { include: { serviceType: true } },
            customer: true,
            vehicle: true,
            site: true,
          },
        });
      });

      await this.statusHistory.record({
        entityType: 'Appointment',
        entityId: id,
        fromStatus: existing.status,
        toStatus: 'RESCHEDULED',
        changedByUserId: userId,
      });
      await this.auditStaffPlacement(id, userId, capacityOutcome, latestStartOverridden, baseStart, rescheduleCtx);
      if (data.scheduledStartAt) await this.notifyOnlineBookingChange('RESCHEDULED', appointment as never, userId);

      return appointment;
    }

    // Simple update (no service type changes)
    const wasRescheduled = !!data.scheduledStartAt;
    let simpleCapacity: { overbooked: boolean; capacity: number; booked: number } | null = null;
    if (wasRescheduled) {
      updateData.status = 'RESCHEDULED';
      // P4(a): rescheduled — re-check same-vehicle overlap (exclude self).
      await this.validateNoVehicleOverlap(
        existing.vehicleId,
        existing.siteId,
        updateData.scheduledStartAt as Date,
        (updateData.scheduledEndAt as Date) ?? existing.scheduledEndAt ?? (updateData.scheduledStartAt as Date),
        id,
      );
      if (rescheduleCtx) {
        latestStartOverridden = this.availability!.assertSlotAllowed(
          updateData.scheduledStartAt as Date,
          (updateData.scheduledEndAt as Date) ?? (updateData.scheduledStartAt as Date),
          rescheduleCtx.site,
          rescheduleCtx.rules,
          'STAFF',
          { overrideLatestStart: data.overrideLatestStart === true },
        ).latestStartOverridden;
      }
    }

    const include = {
      services: { include: { serviceType: true } },
      customer: true,
      vehicle: true,
      site: true,
    };
    // CR-2026-106 — a moved time is written under the day lock with the capacity
    // re-checked (same guarantee as the public confirm); other edits stay simple.
    const appointment =
      wasRescheduled && rescheduleCtx
        ? await this.prisma.$transaction(async (tx) => {
            simpleCapacity = await this.guardStaffSlot(
              tx,
              rescheduleCtx,
              updateData.scheduledStartAt as Date,
              this.availability!.slotRules(existing.services.map((s) => s.serviceType), rescheduleCtx.rules, 'STAFF', rescheduleVehicleClass),
              data.acknowledgeCapacity === true,
              id,
            );
            return tx.appointment.update({ where: { id }, data: updateData, include });
          })
        : await this.prisma.appointment.update({ where: { id }, data: updateData, include });

    if (wasRescheduled) {
      await this.auditStaffPlacement(id, userId, simpleCapacity, latestStartOverridden, updateData.scheduledStartAt as Date, rescheduleCtx);
      await this.notifyOnlineBookingChange('RESCHEDULED', appointment as never, userId);
      await this.statusHistory.record({
        entityType: 'Appointment',
        entityId: id,
        fromStatus: existing.status,
        toStatus: 'RESCHEDULED',
        changedByUserId: userId,
      });
    }

    return appointment;
  }

  // ---------------------------------------------------------------------------
  // CONFIRM
  // ---------------------------------------------------------------------------

  async confirm(id: string, userId: string) {
    const existing = await this.findById(id);

    if (!['DRAFT', 'RESCHEDULED'].includes(existing.status)) {
      throw new BadRequestException(
        `Cannot confirm appointment in status ${existing.status}`,
      );
    }

    const appointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmationStatus: 'CONFIRMED',
      },
      include: {
        services: { include: { serviceType: true } },
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    await this.statusHistory.record({
      entityType: 'Appointment',
      entityId: id,
      fromStatus: existing.status,
      toStatus: 'CONFIRMED',
      changedByUserId: userId,
    });

    this.logger.log(
      `[NOTIFICATION_PLACEHOLDER] Appointment ${id} confirmed — queue confirmation SMS/email`,
    );

    return appointment;
  }

  // ---------------------------------------------------------------------------
  // CANCEL
  // ---------------------------------------------------------------------------

  async cancel(id: string, reason: string, userId: string) {
    const existing = await this.findById(id);

    if (['CANCELLED', 'COMPLETED'].includes(existing.status)) {
      throw new BadRequestException(
        `Cannot cancel appointment in status ${existing.status}`,
      );
    }

    const appointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        // CR-2026-106 — a cancelled online booking's manage link stops working at once.
        ...(existing.manageTokenHash ? { manageTokenExpiresAt: new Date() } : {}),
      },
      include: {
        services: { include: { serviceType: true } },
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    await this.statusHistory.record({
      entityType: 'Appointment',
      entityId: id,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      changedByUserId: userId,
      reasonCode: 'APPOINTMENT_CANCEL',
      notes: reason,
    });
    await this.notifyOnlineBookingChange('CANCELLED', appointment as never, userId);

    await this.auditService.log({
      actorUserId: userId,
      action: AUDIT_ACTIONS.APPOINTMENT_CANCEL,
      entityType: 'Appointment',
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: 'CANCELLED' },
      reasonCode: 'APPOINTMENT_CANCEL',
      notes: reason,
    });

    this.logger.log(
      `[NOTIFICATION_PLACEHOLDER] Appointment ${id} cancelled — queue cancellation notification`,
    );

    return appointment;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /** CR-2026-106 — audit an acknowledged overbooking and/or latest-start override on a reschedule. */
  private async auditStaffPlacement(
    appointmentId: string,
    userId: string,
    capacity: { overbooked: boolean; capacity: number; booked: number } | null,
    latestStartOverridden: boolean,
    scheduledStartAt: Date,
    ctx: { rules: BookingRuleSet } | null,
  ): Promise<void> {
    if (capacity?.overbooked) {
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.APPOINTMENT_CAPACITY_ACKNOWLEDGED,
        entityType: 'Appointment',
        entityId: appointmentId,
        afterJson: { capacity: capacity.capacity, booked: capacity.booked, scheduledStartAt, onReschedule: true },
        reasonCode: 'CAPACITY_FULL',
      });
    }
    if (latestStartOverridden) {
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.APPOINTMENT_LATEST_START_OVERRIDDEN,
        entityType: 'Appointment',
        entityId: appointmentId,
        afterJson: { scheduledStartAt, latestStart: ctx?.rules.booking.customerLatestStart ?? null, onReschedule: true },
        reasonCode: 'AFTER_LATEST_START',
      });
    }
  }

  /**
   * DMAIC Rule 1 — Same-day scheduling cutoff.
   *
   * Blocks creating a same-day appointment once the current site-local time is at/after
   * the configured cutoff (`same_day_appointment_cutoff_time`, default 10:00), unless a
   * manager override is supplied — in which case the override is audited. The cutoff value
   * and enforcement flag come from BusinessRuleConfig (not hard-coded). All comparisons are
   * done in the SITE's timezone. `now` is injectable for deterministic testing.
   */
  async enforceSameDayCutoff(
    scheduledStartAt: Date,
    siteId: string,
    managerOverride: boolean,
    userId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { timezone: true },
    });
    const tz = site?.timezone ?? 'America/Jamaica';
    const nowLocal = toZonedTime(now, tz);
    const scheduledLocal = toZonedTime(scheduledStartAt, tz);

    // Rule applies only to same-day (site-local) bookings.
    if (!isSameDay(nowLocal, scheduledLocal)) return;

    const enforceRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'manager_override_required_after_cutoff', effectiveTo: null },
    });
    const enforced = (enforceRule?.valueJson as boolean) ?? true;
    if (!enforced) return;

    const cutoffRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'same_day_appointment_cutoff_time', effectiveTo: null },
    });
    const cutoffTime = (cutoffRule?.valueJson as string) ?? '10:00';
    const [cutH, cutM] = cutoffTime.split(':').map(Number);

    const nowMinutes = getHours(nowLocal) * 60 + getMinutes(nowLocal);
    const cutoffMinutes = cutH * 60 + cutM;
    if (nowMinutes < cutoffMinutes) return; // before cutoff — allowed

    if (!managerOverride) {
      throw new BadRequestException(
        `Same-day appointments after ${cutoffTime} require manager approval. Set managerOverride: true to proceed.`,
      );
    }

    // Override bypassed the cutoff — audit it.
    await this.auditService.log({
      actorUserId: userId,
      action: AUDIT_ACTIONS.SAME_DAY_CUTOFF_OVERRIDE,
      entityType: 'Appointment',
      afterJson: {
        siteId,
        cutoffTime,
        scheduledStartAt: scheduledStartAt.toISOString(),
        bookedAt: now.toISOString(),
      },
      reasonCode: 'SAME_DAY_CUTOFF_OVERRIDE',
    });
  }

  /**
   * P4(a) — reject a new/rescheduled appointment when the SAME vehicle already
   * has an active appointment whose time window overlaps the requested window.
   *
   * Scope note: bays, work resources, and technicians are NOT bound at
   * appointment creation (they are assigned later at dispatch via
   * ResourceReservation), so bay/resource/technician-level double-booking is
   * intentionally NOT enforced here. This guard only covers the unambiguous,
   * already-modelled conflict: the same vehicle in two overlapping appointments.
   */
  private async validateNoVehicleOverlap(
    vehicleId: string,
    siteId: string,
    startAt: Date,
    endAt: Date,
    excludeAppointmentId?: string,
  ): Promise<void> {
    const conflict = await this.prisma.appointment.findFirst({
      where: {
        siteId,
        vehicleId,
        status: { notIn: ['CANCELLED', 'COMPLETED', 'MISSED'] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        OR: [
          // Overlap against a known end window: existing.start < new.end AND existing.end > new.start
          { AND: [{ scheduledStartAt: { lt: endAt } }, { scheduledEndAt: { gt: startAt } }] },
          // Open-ended existing appointment (no end recorded): treat its start instant as the window
          { AND: [{ scheduledEndAt: null }, { scheduledStartAt: { gte: startAt, lt: endAt } }] },
        ],
      },
      select: { id: true, scheduledStartAt: true },
    });

    if (conflict) {
      throw new BadRequestException(
        `This vehicle already has an appointment overlapping this time ` +
          `(${conflict.scheduledStartAt.toISOString()}). Choose a non-overlapping time.`,
      );
    }
  }

  /**
   * Validate that the requested datetime falls within the site's operating hours.
   * Loads the BusinessRuleConfig with ruleKey='operating_hours' for the given site.
   */
  private async validateOperatingHours(
    scheduledStartAt: Date,
    siteId: string,
  ): Promise<void> {
    // Load operating hours config for this site (site-specific first, then global fallback)
    const now = new Date();
    const config = await this.prisma.businessRuleConfig.findFirst({
      where: {
        ruleKey: 'operating_hours',
        effectiveFrom: { lte: now },
        AND: [
          { OR: [{ siteId }, { siteId: null }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
        ],
      },
      orderBy: { siteId: 'desc' }, // site-specific takes precedence over global (null)
    });

    if (!config) {
      this.logger.warn(
        `No operating_hours config found for site ${siteId} — skipping validation`,
      );
      return;
    }

    // Resolve the site timezone
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { timezone: true },
    });
    const siteTimezone = site?.timezone ?? 'America/Jamaica';

    const operatingHours = config.valueJson as unknown as OperatingHoursSchedule;

    if (
      !this.isWithinOperatingHours(
        scheduledStartAt,
        operatingHours,
        siteTimezone,
      )
    ) {
      throw new BadRequestException(
        'Scheduled time is outside of operating hours for this site',
      );
    }
  }

  /**
   * Check if a given UTC datetime falls within the site's operating hours
   * after converting to the site's local timezone.
   */
  isWithinOperatingHours(
    scheduledStartAt: Date,
    operatingHoursConfig: OperatingHoursSchedule,
    siteTimezone: string,
  ): boolean {
    const zonedTime = toZonedTime(scheduledStartAt, siteTimezone);
    const dayOfWeek = getDay(zonedTime); // 0=Sunday ... 6=Saturday
    const dayKey = String(dayOfWeek);

    const daySchedule = operatingHoursConfig.schedule[dayKey];
    if (!daySchedule) {
      // Site is closed on this day
      return false;
    }

    const [openHour, openMinute] = daySchedule.open.split(':').map(Number);
    const [closeHour, closeMinute] = daySchedule.close.split(':').map(Number);

    const hour = getHours(zonedTime);
    const minute = getMinutes(zonedTime);
    const requestedMinutes = hour * 60 + minute;
    const openMinutes = openHour * 60 + openMinute;
    const closeMinutes = closeHour * 60 + closeMinute;

    return requestedMinutes >= openMinutes && requestedMinutes < closeMinutes;
  }

  /**
   * Resolve service type codes to their database records.
   * Throws if any code is not found or not active.
   */
  private async resolveServiceTypeCodes(codes: string[]): Promise<Map<string, StaffMeasurableService>> {
    const uniqueCodes = [...new Set(codes)];

    const serviceTypes = await this.prisma.serviceType.findMany({
      where: { code: { in: uniqueCodes }, isActive: true },
      // CR-2026-111b — the shared duration select. This query used to name
      // `baseDurationMinutes` alone, which is why a staff-created SUV general
      // service planned 90 minutes while the same booking made by the customer
      // planned 120. One select, one rule, no divergence.
      select: SERVICE_DURATION_SELECT,
    });

    const map = new Map(
      serviceTypes.map((st) => [
        st.code,
        {
          id: st.id,
          code: st.code,
          baseDurationMinutes: st.baseDurationMinutes,
          sedanDurationMinutes: st.sedanDurationMinutes,
          suvDurationMinutes: st.suvDurationMinutes,
        },
      ]),
    );

    const missing = uniqueCodes.filter((c) => !map.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown or inactive service type codes: ${missing.join(', ')}`,
      );
    }

    return map;
  }

  /**
   * SCH-004: Find an existing appointment for the same customer+vehicle
   * on the same calendar day at the same site.
   */
  private async findSameDayAppointment(
    customerId: string,
    vehicleId: string,
    siteId: string,
    scheduledStartAt: Date,
  ) {
    const dayStart = startOfDay(scheduledStartAt);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    return this.prisma.appointment.findFirst({
      where: {
        customerId,
        vehicleId,
        siteId,
        scheduledStartAt: { gte: dayStart, lt: dayEnd },
        status: { notIn: ['CANCELLED', 'COMPLETED', 'MISSED'] },
      },
      include: {
        services: { include: { serviceType: true } },
      },
    });
  }

  /**
   * Merge additional services into an existing same-day appointment (SCH-004).
   * Avoids duplicating service types that are already on the appointment.
   */
  private async mergeServicesIntoExisting(
    appointmentId: string,
    newServices: { serviceTypeCode: string; qty?: number; notes?: string }[],
    serviceTypeMap: Map<string, StaffMeasurableService>,
    userId: string,
  ) {
    const existing = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: { services: true },
    });
    // CR-2026-111c — merging services into an appointment recomputes its end, so
    // the vehicle class applies here too.
    const mergeVehicleClass = await this.resolveVehicleClass(
      existing.vehicleId,
      [...serviceTypeMap.values()],
    );

    const existingTypeIds = new Set(existing.services.map((s) => s.serviceTypeId));

    const servicesToAdd = newServices
      .filter((s) => !existingTypeIds.has(serviceTypeMap.get(s.serviceTypeCode)!.id))
      .map((s) => ({
        appointmentId,
        serviceTypeId: serviceTypeMap.get(s.serviceTypeCode)!.id,
        qty: s.qty ?? 1,
        requestedNotes: s.notes,
      }));

    if (servicesToAdd.length > 0) {
      await this.prisma.appointmentService.createMany({
        data: servicesToAdd,
      });

      // Recalculate scheduledEndAt with newly merged services
      const allServices = await this.prisma.appointmentService.findMany({
        where: { appointmentId },
        include: { serviceType: true },
      });

      const totalDuration = allServices.reduce(
        (sum, s) => sum + catalogueMinutesFor(s.serviceType, mergeVehicleClass) * s.qty,
        0,
      );

      const newEndAt = new Date(
        existing.scheduledStartAt.getTime() + totalDuration * 60 * 1000,
      );

      await this.prisma.appointment.update({
        where: { id: appointmentId },
        data: { scheduledEndAt: newEndAt },
      });
    }

    this.logger.log(
      `[SAME_DAY_MERGE] Merged ${servicesToAdd.length} new service(s) into appointment ${appointmentId}`,
    );

    return this.findById(appointmentId);
  }
}
