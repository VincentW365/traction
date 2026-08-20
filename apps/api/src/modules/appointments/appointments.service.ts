import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { toZonedTime } from 'date-fns-tz';
import { getDay, getHours, getMinutes, startOfDay, isBefore, isSameDay } from 'date-fns';

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
  ) {}

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

    // 5. Calculate estimated end time from service durations
    const totalDurationMinutes = data.serviceTypes.reduce((sum, s) => {
      const st = serviceTypeMap.get(s.serviceTypeCode);
      return sum + (st?.baseDurationMinutes ?? 0) * (s.qty ?? 1);
    }, 0);

    const scheduledEndAt = new Date(
      scheduledStartAt.getTime() + totalDurationMinutes * 60 * 1000,
    );

    // 5b. P4(a): reject an overlapping active appointment for the SAME vehicle.
    await this.validateNoVehicleOverlap(
      data.vehicleId,
      data.siteId,
      scheduledStartAt,
      scheduledEndAt,
    );

    // 6. Create appointment + appointment_services in a transaction
    const appointment = await this.prisma.$transaction(async (tx) => {
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
        const totalDuration = services.reduce(
          (sum, s) => sum + s.serviceType.baseDurationMinutes * s.qty,
          0,
        );
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

      const totalDuration = data.serviceTypes.reduce((sum, s) => {
        const st = serviceTypeMap.get(s.serviceTypeCode);
        return sum + (st?.baseDurationMinutes ?? 0) * (s.qty ?? 1);
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

      // Delete existing services and create new ones inside transaction
      const appointment = await this.prisma.$transaction(async (tx) => {
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

      return appointment;
    }

    // Simple update (no service type changes)
    const wasRescheduled = !!data.scheduledStartAt;
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
    }

    const appointment = await this.prisma.appointment.update({
      where: { id },
      data: updateData,
      include: {
        services: { include: { serviceType: true } },
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (wasRescheduled) {
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
      data: { status: 'CANCELLED' },
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
  private async resolveServiceTypeCodes(
    codes: string[],
  ): Promise<Map<string, { id: string; baseDurationMinutes: number }>> {
    const uniqueCodes = [...new Set(codes)];

    const serviceTypes = await this.prisma.serviceType.findMany({
      where: { code: { in: uniqueCodes }, isActive: true },
      select: { id: true, code: true, baseDurationMinutes: true },
    });

    const map = new Map(
      serviceTypes.map((st) => [
        st.code,
        { id: st.id, baseDurationMinutes: st.baseDurationMinutes },
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
    serviceTypeMap: Map<string, { id: string; baseDurationMinutes: number }>,
    userId: string,
  ) {
    const existing = await this.prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      include: { services: true },
    });

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
        (sum, s) => sum + s.serviceType.baseDurationMinutes * s.qty,
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
