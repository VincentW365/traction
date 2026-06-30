import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  NOTIFICATION_PROVIDER,
  NotificationProvider,
} from './providers/notification-provider.interface';
import { NotificationChannel, NotificationDeliveryStatus } from '@prisma/client';

export interface QueueNotificationInput {
  entityType: string;
  entityId: string;
  channel: 'SMS' | 'EMAIL';
  templateKey: string;
  recipient: string;
  templateData: Record<string, unknown>;
  scheduledAt?: Date;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDER)
    private provider: NotificationProvider,
  ) {}

  async queue(input: QueueNotificationInput): Promise<string> {
    const log = await this.prisma.notificationLog.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        channel: input.channel as NotificationChannel,
        templateKey: input.templateKey,
        recipient: input.recipient,
        status: input.scheduledAt ? 'SCHEDULED' : 'PENDING',
        scheduledAt: input.scheduledAt,
      },
    });

    // In Phase 1, process immediately (no BullMQ queue yet)
    // Phase 4 will replace this with BullMQ job scheduling
    if (!input.scheduledAt) {
      await this.processNotification(log.id, input);
    }

    return log.id;
  }

  private async processNotification(
    logId: string,
    input: QueueNotificationInput,
  ) {
    try {
      const result = await this.provider.send({
        channel: input.channel,
        recipient: input.recipient,
        templateKey: input.templateKey,
        templateData: input.templateData,
      });

      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: result.success
            ? ('SENT' as NotificationDeliveryStatus)
            : ('FAILED' as NotificationDeliveryStatus),
          providerReference: result.providerReference,
          sentAt: result.success ? new Date() : undefined,
          failureReason: result.failureReason,
        },
      });
    } catch (error) {
      this.logger.error(`Notification ${logId} failed:`, error);
      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: 'FAILED' as NotificationDeliveryStatus,
          failureReason:
            error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  async queueAppointmentConfirmation(
    appointmentId: string,
    customerPhone: string,
    customerEmail: string | null,
    appointmentDetails: {
      scheduledStartAt: Date;
      services: string[];
      siteName: string;
    },
  ) {
    // Queue SMS confirmation
    await this.queue({
      entityType: 'Appointment',
      entityId: appointmentId,
      channel: 'SMS',
      templateKey: 'appointment_confirmation',
      recipient: customerPhone,
      templateData: appointmentDetails,
    });

    // Queue email confirmation if available
    if (customerEmail) {
      await this.queue({
        entityType: 'Appointment',
        entityId: appointmentId,
        channel: 'EMAIL',
        templateKey: 'appointment_confirmation',
        recipient: customerEmail,
        templateData: appointmentDetails,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — Reminder, delay, and pickup notifications
  // ---------------------------------------------------------------------------

  /**
   * Schedule a reminder notification (24h or 2h) before an appointment.
   */
  async scheduleReminder(
    appointmentId: string,
    reminderType: '24h' | '2h',
  ): Promise<string[]> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        customer: true,
        services: { include: { serviceType: true } },
        site: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException(`Appointment ${appointmentId} not found`);
    }

    const hoursOffset = reminderType === '24h' ? 24 : 2;
    const scheduledAt = new Date(
      appointment.scheduledStartAt.getTime() - hoursOffset * 60 * 60 * 1000,
    );

    // Don't schedule if the reminder time is already in the past
    if (scheduledAt <= new Date()) {
      this.logger.warn(
        `Skipping ${reminderType} reminder for appointment ${appointmentId}: scheduled time is in the past`,
      );
      return [];
    }

    const templateKey = `appointment_reminder_${reminderType}`;
    const templateData = {
      scheduledStartAt: appointment.scheduledStartAt,
      services: appointment.services.map((s) => s.serviceType.name),
      siteName: appointment.site.name,
    };

    const ids: string[] = [];

    // SMS reminder
    if (appointment.customer.notificationOptInSms) {
      const smsId = await this.queue({
        entityType: 'Appointment',
        entityId: appointmentId,
        channel: 'SMS',
        templateKey,
        recipient: appointment.customer.phone,
        templateData,
        scheduledAt,
      });
      ids.push(smsId);
    }

    // Email reminder
    if (
      appointment.customer.email &&
      appointment.customer.notificationOptInEmail
    ) {
      const emailId = await this.queue({
        entityType: 'Appointment',
        entityId: appointmentId,
        channel: 'EMAIL',
        templateKey,
        recipient: appointment.customer.email,
        templateData,
        scheduledAt,
      });
      ids.push(emailId);
    }

    return ids;
  }

  /**
   * Send a delay alert if the new estimated completion exceeds the original
   * promised time by more than 15 minutes.
   */
  async sendDelayAlert(
    serviceVisitId: string,
    newEstimatedCompletion: Date,
  ): Promise<string[]> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: {
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!visit) {
      throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    }

    // Only send if delay exceeds 15 minutes from original promised time
    const originalEta = visit.currentEtaCompleteAt;
    if (originalEta) {
      const delayMs =
        newEstimatedCompletion.getTime() - originalEta.getTime();
      const delayMinutes = delayMs / (60 * 1000);
      if (delayMinutes <= 15) {
        this.logger.log(
          `Delay for visit ${serviceVisitId} is ${delayMinutes.toFixed(1)}min — under 15min threshold, skipping alert`,
        );
        return [];
      }
    }

    const templateData = {
      customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
      vehiclePlate: visit.vehicle.plateNumber,
      newEstimatedCompletion,
      siteName: visit.site.name,
    };

    const ids: string[] = [];

    if (visit.customer.notificationOptInSms) {
      const smsId = await this.queue({
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        channel: 'SMS',
        templateKey: 'service_delay_alert',
        recipient: visit.customer.phone,
        templateData,
      });
      ids.push(smsId);
    }

    if (visit.customer.email && visit.customer.notificationOptInEmail) {
      const emailId = await this.queue({
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        channel: 'EMAIL',
        templateKey: 'service_delay_alert',
        recipient: visit.customer.email,
        templateData,
      });
      ids.push(emailId);
    }

    return ids;
  }

  /**
   * Send a "your vehicle is ready for pickup" notification.
   */
  async sendReadyForPickup(serviceVisitId: string): Promise<string[]> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: {
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!visit) {
      throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    }

    const templateData = {
      customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
      vehiclePlate: visit.vehicle.plateNumber,
      vehicleMake: visit.vehicle.make,
      vehicleModel: visit.vehicle.model,
      siteName: visit.site.name,
    };

    const ids: string[] = [];

    if (visit.customer.notificationOptInSms) {
      const smsId = await this.queue({
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        channel: 'SMS',
        templateKey: 'ready_for_pickup',
        recipient: visit.customer.phone,
        templateData,
      });
      ids.push(smsId);
    }

    if (visit.customer.email && visit.customer.notificationOptInEmail) {
      const emailId = await this.queue({
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        channel: 'EMAIL',
        templateKey: 'ready_for_pickup',
        recipient: visit.customer.email,
        templateData,
      });
      ids.push(emailId);
    }

    return ids;
  }

  // ---------------------------------------------------------------------------
  // v4.1 — Front-desk-initiated pickup notification with channel choice
  // ---------------------------------------------------------------------------

  /**
   * Send a pickup-ready notification via channels chosen by front desk staff.
   * Supports SMS, EMAIL, and MANUAL_CALL (staff calls customer directly).
   * Every attempt is logged in NotificationLog including manual calls.
   */
  async sendPickupReady(
    serviceVisitId: string,
    channels: string[],
    userId: string,
  ): Promise<{ sent: Array<{ channel: string; status: string; recipient: string }> }> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: {
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!visit) {
      throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    }

    const results: Array<{ channel: string; status: string; recipient: string }> = [];

    for (const channel of channels) {
      if (channel === 'SMS') {
        const logId = await this.queue({
          entityType: 'ServiceVisit',
          entityId: serviceVisitId,
          channel: 'SMS',
          templateKey: 'pickup_ready',
          recipient: visit.customer.phone,
          templateData: {
            customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
            vehiclePlate: visit.vehicle.plateNumber,
            siteName: visit.site.name,
          },
        });
        // Update with initiatedByUserId
        await this.prisma.notificationLog.update({
          where: { id: logId },
          data: { initiatedByUserId: userId, templateVersion: 1 },
        });
        results.push({ channel: 'SMS', status: 'SENT', recipient: visit.customer.phone });

      } else if (channel === 'EMAIL' && visit.customer.email) {
        const logId = await this.queue({
          entityType: 'ServiceVisit',
          entityId: serviceVisitId,
          channel: 'EMAIL',
          templateKey: 'pickup_ready',
          recipient: visit.customer.email,
          templateData: {
            customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
            vehiclePlate: visit.vehicle.plateNumber,
            siteName: visit.site.name,
          },
        });
        await this.prisma.notificationLog.update({
          where: { id: logId },
          data: { initiatedByUserId: userId, templateVersion: 1 },
        });
        results.push({ channel: 'EMAIL', status: 'SENT', recipient: visit.customer.email });

      } else if (channel === 'MANUAL_CALL') {
        // Log that staff chose to call manually — no actual send
        await this.prisma.notificationLog.create({
          data: {
            entityType: 'ServiceVisit',
            entityId: serviceVisitId,
            channel: 'MANUAL_CALL',
            templateKey: 'pickup_ready',
            templateVersion: 1,
            recipient: visit.customer.phone,
            status: 'MANUAL',
            initiatedByUserId: userId,
            sentAt: new Date(),
          },
        });
        results.push({ channel: 'MANUAL_CALL', status: 'MANUAL', recipient: visit.customer.phone });
      }
    }

    return {
      sent: results,
    };
  }

  /**
   * Get notification log entries for a given entity.
   */
  async getLogForEntity(entityId: string) {
    return this.prisma.notificationLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * DMAIC Rule 2 — Midday completion follow-up.
   *
   * Sends a same-day follow-up to customers whose job was COMPLETED before 12:00 PM
   * (site-local time) — NOT merely in queue before noon. Completion is detected via
   * the `COMPLETED` QueueEvent written when a technician marks work done.
   *
   * Idempotent: each visit is followed up at most once (deduped on NotificationLog
   * templateKey `midday_followup`), so the same completion never sends duplicates and
   * the batch is safe to run repeatedly (e.g. on a schedule around noon).
   *
   * Touches no scheduling/ETA/rank/bay logic — read-only over completion events.
   *
   * @param now injectable clock for testability (defaults to current time)
   */
  async sendMiddayCompletionFollowUp(
    siteId: string,
    now: Date = new Date(),
  ): Promise<{ sent: number; skipped: number }> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { timezone: true },
    });
    const tz = site?.timezone || 'America/Jamaica';
    const todayKey = this.zonedParts(now, tz).date;

    // Look back far enough to cover "today" in any timezone; filter precisely below.
    const since = new Date(now.getTime() - 36 * 60 * 60 * 1000);

    const completions = await this.prisma.queueEvent.findMany({
      where: {
        eventType: 'COMPLETED',
        createdAt: { gte: since, lte: now },
        serviceVisit: { siteId },
      },
      select: {
        createdAt: true,
        serviceVisit: {
          select: {
            id: true,
            customer: {
              select: { firstName: true, phone: true, email: true, notificationOptInSms: true, notificationOptInEmail: true },
            },
            vehicle: { select: { plateNumber: true, make: true, model: true, modelYear: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    let sent = 0;
    let skipped = 0;
    const handled = new Set<string>();

    for (const ev of completions) {
      const visit = ev.serviceVisit;
      if (!visit || handled.has(visit.id)) continue;

      // Rule 2: completed TODAY and BEFORE 12:00 PM site-local.
      const parts = this.zonedParts(ev.createdAt, tz);
      if (parts.date !== todayKey || parts.hour >= 12) continue;
      handled.add(visit.id);

      // Idempotency: already followed up for this visit?
      const already = await this.prisma.notificationLog.count({
        where: { entityType: 'ServiceVisit', entityId: visit.id, templateKey: 'midday_followup' },
      });
      if (already > 0) { skipped++; continue; }

      const { customer, vehicle } = visit;
      if (!customer.notificationOptInSms && !customer.notificationOptInEmail) { skipped++; continue; }

      const vehicleDesc = [vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.plateNumber;
      const message = `Hi ${customer.firstName}! Your ${vehicleDesc} was completed this morning at Bert's. Thank you for choosing us — we hope everything's running smoothly, and we'll see you next service!`;

      if (customer.notificationOptInSms && customer.phone) {
        await this.queue({
          entityType: 'ServiceVisit',
          entityId: visit.id,
          channel: 'SMS',
          templateKey: 'midday_followup',
          recipient: customer.phone,
          templateData: { message, customerFirstName: customer.firstName, vehicleDescription: vehicleDesc },
        });
      }

      if (customer.notificationOptInEmail && customer.email) {
        await this.queue({
          entityType: 'ServiceVisit',
          entityId: visit.id,
          channel: 'EMAIL',
          templateKey: 'midday_followup',
          recipient: customer.email,
          templateData: { message, customerFirstName: customer.firstName, vehicleDescription: vehicleDesc },
        });
      }

      sent++;
    }

    this.logger.log(`Midday completion follow-up: ${sent} sent, ${skipped} skipped for site ${siteId}`);
    return { sent, skipped };
  }

  // ---------------------------------------------------------------------------
  // CR-2026-056 — 24-hour appointment reminder sweep
  // ---------------------------------------------------------------------------

  /**
   * Send a one-time reminder for every upcoming appointment that has entered the
   * reminder window (default 24h before `scheduledStartAt`). Run on a schedule
   * (hourly cron) — the dedup makes it safe to run repeatedly and at any cadence.
   *
   * - Window: appointments with `scheduledStartAt` in (now, now + reminderHours].
   *   Sending as soon as an appointment enters the window means the reminder goes
   *   out ~`reminderHours` before the appointment, give or take the cron interval.
   * - Statuses: only still-upcoming, non-terminal appointments (DRAFT, CONFIRMED,
   *   RESCHEDULED) — never CHECKED_IN / IN_PROGRESS / COMPLETED / MISSED / CANCELLED.
   * - Idempotent: one reminder per appointment, deduped on NotificationLog
   *   templateKey `appointment_reminder_24h`.
   * - Respects customer opt-in (notificationOptInSms / notificationOptInEmail).
   * - Sends immediately (no `scheduledAt`) — the sweep itself IS the schedule.
   *
   * Gated by business rules `appointment_reminder_enabled` (default true) and
   * `appointment_reminder_hours` (default 24). Read-only over scheduling/queue.
   *
   * @param now injectable clock for testability (defaults to current time)
   */
  async sweepAppointmentReminders(
    now: Date = new Date(),
  ): Promise<{ sent: number; skipped: number }> {
    const enabledRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'appointment_reminder_enabled', effectiveTo: null },
    });
    if (enabledRule && enabledRule.valueJson === false) {
      return { sent: 0, skipped: 0 };
    }

    const hoursRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'appointment_reminder_hours', effectiveTo: null },
    });
    const reminderHours = (hoursRule?.valueJson as number) ?? 24;
    const windowEnd = new Date(now.getTime() + reminderHours * 60 * 60 * 1000);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: { in: ['DRAFT', 'CONFIRMED', 'RESCHEDULED'] },
        scheduledStartAt: { gt: now, lte: windowEnd },
      },
      include: {
        customer: true,
        services: { include: { serviceType: true } },
        site: true,
      },
    });

    let sent = 0;
    let skipped = 0;

    for (const appt of appointments) {
      // Idempotency: already reminded for this appointment?
      const already = await this.prisma.notificationLog.count({
        where: {
          entityType: 'Appointment',
          entityId: appt.id,
          templateKey: 'appointment_reminder_24h',
        },
      });
      if (already > 0) {
        skipped++;
        continue;
      }

      const customer = appt.customer;
      const smsOk = customer.notificationOptInSms && !!customer.phone;
      const emailOk = !!customer.email && customer.notificationOptInEmail;
      if (!smsOk && !emailOk) {
        skipped++;
        continue;
      }

      const templateData = {
        scheduledStartAt: appt.scheduledStartAt,
        services: appt.services.map((s) => s.serviceType.name),
        siteName: appt.site.name,
      };

      if (smsOk) {
        await this.queue({
          entityType: 'Appointment',
          entityId: appt.id,
          channel: 'SMS',
          templateKey: 'appointment_reminder_24h',
          recipient: customer.phone,
          templateData,
        });
      }
      if (emailOk) {
        await this.queue({
          entityType: 'Appointment',
          entityId: appt.id,
          channel: 'EMAIL',
          templateKey: 'appointment_reminder_24h',
          recipient: customer.email as string,
          templateData,
        });
      }
      sent++;
    }

    this.logger.log(
      `Appointment reminders: ${sent} sent, ${skipped} skipped (window ${reminderHours}h)`,
    );
    return { sent, skipped };
  }

  /** Year-month-day and hour of a timestamp in a given IANA timezone. */
  private zonedParts(date: Date, tz: string): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const o: Record<string, string> = {};
    for (const p of parts) o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 };
  }
}
