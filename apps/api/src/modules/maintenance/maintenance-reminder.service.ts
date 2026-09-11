import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { liveVisitWhere } from '../../common/helpers/operational-scope';

const SITE_TIMEZONE = 'America/Jamaica';
const QUIET_HOUR_START = 8; // 8 AM
const QUIET_HOUR_END = 18; // 6 PM

@Injectable()
export class MaintenanceReminderService {
  private readonly logger = new Logger(MaintenanceReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Auto-create a maintenance reminder after a qualifying post-service recommendation.
   * Respects: eligible service types, customer opt-in, one-active-per-vehicle-service rule.
   */
  async autoCreateFromRecommendation(
    recommendation: {
      id: string;
      vehicleId: string;
      serviceTypeCode: string;
      nextDueOdometer: number | null;
      nextDueDate: Date | null;
      confidence: string;
    },
    customerId: string,
  ) {
    // 1. Check service type is reminder-eligible
    const eligibleRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'reminder_eligible_service_types', effectiveTo: null },
    });
    const eligibleTypes: string[] = eligibleRule
      ? (eligibleRule.valueJson as string[])
      : ['OIL-01'];

    if (!eligibleTypes.includes(recommendation.serviceTypeCode)) {
      this.logger.debug(
        `Skipping reminder for ${recommendation.serviceTypeCode} — not in eligible types`,
      );
      return null;
    }

    // 2. Check customer opt-in
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { notificationOptInSms: true, notificationOptInEmail: true, firstName: true },
    });
    if (!customer || (!customer.notificationOptInSms && !customer.notificationOptInEmail)) {
      this.logger.debug(`Skipping reminder — customer ${customerId} not opted in`);
      return null;
    }

    // 3. Supersede existing SCHEDULED reminders for this vehicle + service type
    await this.supersedeExisting(recommendation.vehicleId, recommendation.serviceTypeCode);

    // 4. Calculate scheduled send date
    const scheduledSendDate = await this.calculateScheduledSendDate(
      recommendation.vehicleId,
      recommendation.nextDueOdometer,
      recommendation.nextDueDate,
    );

    if (!scheduledSendDate) {
      this.logger.warn(
        `Cannot determine send date for reminder on vehicle ${recommendation.vehicleId}`,
      );
      return null;
    }

    // 5. Determine reminder type
    const avgDaily = await this.calculateAverageDailyMiles(recommendation.vehicleId);
    const reminderType = avgDaily != null ? 'BOTH' : 'TIME_BASED';

    // 6. Map confidence
    const confidenceMap: Record<string, string> = {
      OEM: 'OEM_SPEC',
      VERIFIED: 'CONFIRMED',
      NEEDS_CONFIRMATION: 'ESTIMATED_HISTORY',
      ESTIMATE: 'DEFAULT_INTERVAL',
    };
    const confidence = confidenceMap[recommendation.confidence] ?? 'DEFAULT_INTERVAL';

    // 7. Create reminder
    const reminder = await this.prisma.maintenanceReminder.create({
      data: {
        vehicleId: recommendation.vehicleId,
        customerId,
        recommendationId: recommendation.id,
        reminderType,
        confidence: confidence as any,
        scheduledSendDate,
        estimatedDueDate: recommendation.nextDueDate,
        estimatedDueMileage: recommendation.nextDueOdometer,
        status: 'SCHEDULED',
      },
    });

    this.logger.log(
      `Reminder ${reminder.id} created for vehicle ${recommendation.vehicleId} — ` +
        `send date ${scheduledSendDate.toISOString().split('T')[0]}, confidence=${confidence}`,
    );

    return reminder;
  }

  /**
   * Supersede all existing SCHEDULED reminders for a vehicle + service type.
   */
  async supersedeExisting(vehicleId: string, serviceTypeCode: string) {
    const existing = await this.prisma.maintenanceReminder.findMany({
      where: {
        vehicleId,
        status: 'SCHEDULED',
        recommendation: { serviceTypeCode },
      },
    });

    if (existing.length > 0) {
      await this.prisma.maintenanceReminder.updateMany({
        where: { id: { in: existing.map((r) => r.id) } },
        data: { status: 'SUPERSEDED' },
      });
      this.logger.log(
        `Superseded ${existing.length} reminder(s) for vehicle ${vehicleId} / ${serviceTypeCode}`,
      );
    }
  }

  /**
   * Process all SCHEDULED reminders whose send date has arrived.
   * Respects customer opt-in, quiet hours, and logs all sends.
   */
  async processScheduledReminders(): Promise<{ processed: number; skipped: number }> {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    // Check quiet hours (site-local time)
    const siteNow = new Date(
      new Date().toLocaleString('en-US', { timeZone: SITE_TIMEZONE }),
    );
    const hour = siteNow.getHours();
    if (hour < QUIET_HOUR_START || hour >= QUIET_HOUR_END) {
      this.logger.debug(`Outside quiet hours (${hour}h) — skipping reminder processing`);
      return { processed: 0, skipped: 0 };
    }

    const reminders = await this.prisma.maintenanceReminder.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledSendDate: { lte: today },
      },
      include: {
        vehicle: {
          select: { plateNumber: true, make: true, model: true, modelYear: true, odometer: true },
        },
        customer: {
          select: {
            id: true,
            firstName: true,
            phone: true,
            email: true,
            notificationOptInSms: true,
            notificationOptInEmail: true,
          },
        },
        recommendation: {
          select: { nextDueOdometer: true, nextDueDate: true, confidence: true },
        },
      },
    });

    let processed = 0;
    let skipped = 0;

    for (const reminder of reminders) {
      const { customer, vehicle, recommendation } = reminder;

      // Re-check opt-in
      if (!customer.notificationOptInSms && !customer.notificationOptInEmail) {
        this.logger.debug(`Skipping reminder ${reminder.id} — customer opted out`);
        skipped++;
        continue;
      }

      // Build message
      const vehicleDesc = [vehicle.modelYear, vehicle.make, vehicle.model]
        .filter(Boolean)
        .join(' ') || vehicle.plateNumber;
      const nextDueMiles = recommendation?.nextDueOdometer ?? reminder.estimatedDueMileage;

      const isHighConfidence =
        recommendation?.confidence === 'OEM' ||
        recommendation?.confidence === 'VERIFIED';

      const messageBody = isHighConfidence
        ? `Hi ${customer.firstName}! Your ${vehicleDesc} is coming up on its next oil change at ${nextDueMiles?.toLocaleString() ?? '?'} miles. Please check your odometer — if you're getting close, give us a call or book online. We'd love to see you at Bert's!`
        : `Hi ${customer.firstName}! Based on your last visit, your ${vehicleDesc} may be approaching its next oil change around ${nextDueMiles?.toLocaleString() ?? '?'} miles. Please check your odometer and if you're near that mark, it's a great time to come in. We're here for you at Bert's Auto Parts!`;

      const templateData = {
        customerFirstName: customer.firstName,
        vehicleDescription: vehicleDesc,
        nextDueMiles: nextDueMiles ?? 0,
        nextDueDate: reminder.estimatedDueDate?.toISOString().split('T')[0] ?? 'soon',
        message: messageBody,
      };

      // Send via opted-in channels
      let lastLogId: string | null = null;

      if (customer.notificationOptInSms && customer.phone) {
        lastLogId = await this.notifications.queue({
          entityType: 'MaintenanceReminder',
          entityId: reminder.id,
          channel: 'SMS',
          templateKey: 'maintenance_oil_change_reminder',
          recipient: customer.phone,
          templateData,
        });
      }

      if (customer.notificationOptInEmail && customer.email) {
        lastLogId = await this.notifications.queue({
          entityType: 'MaintenanceReminder',
          entityId: reminder.id,
          channel: 'EMAIL',
          templateKey: 'maintenance_oil_change_reminder',
          recipient: customer.email,
          templateData,
        });
      }

      // Update reminder status
      await this.prisma.maintenanceReminder.update({
        where: { id: reminder.id },
        data: {
          status: 'SENT',
          notificationLogId: lastLogId,
        },
      });

      await this.audit.log({
        actorUserId: null, // system-initiated (audit.service.ts convention; 'SYSTEM' is not a uuid)
        action: 'MAINTENANCE_REMINDER_PROCESSED',
        entityType: 'MaintenanceReminder',
        entityId: reminder.id,
        afterJson: {
          vehicleId: reminder.vehicleId,
          customerId: customer.id,
          channels: [
            customer.notificationOptInSms ? 'SMS' : null,
            customer.notificationOptInEmail ? 'EMAIL' : null,
          ].filter(Boolean),
        },
      });

      processed++;
    }

    this.logger.log(
      `Reminder processing complete: ${processed} sent, ${skipped} skipped`,
    );

    return { processed, skipped };
  }

  /**
   * List reminders with optional filters.
   */
  async findReminders(filters: {
    vehicleId?: string;
    customerId?: string;
    status?: string;
  }) {
    const where: any = {};
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status;

    return this.prisma.maintenanceReminder.findMany({
      where,
      include: {
        vehicle: {
          select: { plateNumber: true, make: true, model: true, modelYear: true },
        },
        customer: {
          select: { firstName: true, lastName: true, phone: true },
        },
        recommendation: {
          select: { serviceTypeCode: true, nextDueOdometer: true, nextDueDate: true, confidence: true },
        },
      },
      orderBy: { scheduledSendDate: 'asc' },
      take: 100,
    });
  }

  /**
   * Calculate average daily miles for a vehicle from service visit mileage history.
   * Returns null if fewer than 2 visits with mileage data.
   */
  async calculateAverageDailyMiles(vehicleId: string): Promise<number | null> {
    const visits = await this.prisma.serviceVisit.findMany({
      where: {
        vehicleId,
        mileageIn: { not: null },
        checkedInAt: { not: null },
        // CR-2026-006: always exclude HISTORICAL_IMPORT visits from the mileage
        // cadence model (their odometer/check-in data is back-loaded and would
        // distort the average-daily-miles estimate). No opt-in here.
        ...liveVisitWhere(false),
      },
      select: { mileageIn: true, checkedInAt: true },
      orderBy: { checkedInAt: 'asc' },
    });

    if (visits.length < 2) return null;

    let totalMiles = 0;
    let totalDays = 0;

    for (let i = 1; i < visits.length; i++) {
      const milesDelta = visits[i].mileageIn! - visits[i - 1].mileageIn!;
      const daysDelta =
        (visits[i].checkedInAt!.getTime() - visits[i - 1].checkedInAt!.getTime()) /
        (1000 * 60 * 60 * 24);

      if (milesDelta > 0 && daysDelta > 0) {
        totalMiles += milesDelta;
        totalDays += daysDelta;
      }
    }

    if (totalDays === 0) return null;
    return totalMiles / totalDays;
  }

  /**
   * Estimate when a vehicle will reach a target odometer reading.
   */
  async estimateArrivalDate(
    vehicleId: string,
    targetOdometer: number,
  ): Promise<Date | null> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { odometer: true },
    });
    if (!vehicle?.odometer || vehicle.odometer >= targetOdometer) return null;

    const avgDaily = await this.calculateAverageDailyMiles(vehicleId);
    if (!avgDaily || avgDaily <= 0) return null;

    const remainingMiles = targetOdometer - vehicle.odometer;
    const daysUntil = Math.ceil(remainingMiles / avgDaily);

    const estimated = new Date();
    estimated.setDate(estimated.getDate() + daysUntil);
    return estimated;
  }

  /**
   * Calculate the optimal send date for a reminder.
   * Uses mileage estimation when possible, falls back to date-based.
   */
  private async calculateScheduledSendDate(
    vehicleId: string,
    nextDueOdometer: number | null,
    nextDueDate: Date | null,
  ): Promise<Date | null> {
    // Read config
    const leadDaysRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'reminder_lead_days', effectiveTo: null },
    });
    const thresholdRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'reminder_mileage_threshold', effectiveTo: null },
    });

    const leadDays = (leadDaysRule?.valueJson as number) ?? 14;
    const mileageThreshold = (thresholdRule?.valueJson as number) ?? 500;

    let mileageDate: Date | null = null;
    let timeDate: Date | null = null;

    // Try mileage-based estimation
    if (nextDueOdometer) {
      const thresholdOdometer = nextDueOdometer - mileageThreshold;
      mileageDate = await this.estimateArrivalDate(vehicleId, thresholdOdometer);
    }

    // Time-based fallback
    if (nextDueDate) {
      timeDate = new Date(nextDueDate);
      timeDate.setDate(timeDate.getDate() - leadDays);
    }

    // Use the earlier of the two dates (give more advance notice)
    if (mileageDate && timeDate) {
      return mileageDate < timeDate ? mileageDate : timeDate;
    }
    return mileageDate ?? timeDate;
  }
}
