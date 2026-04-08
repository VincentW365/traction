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
}
