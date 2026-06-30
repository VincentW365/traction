import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

/**
 * CR-2026-056 — scheduled appointment-reminder sweep.
 *
 * Runs hourly and delegates to NotificationsService.sweepAppointmentReminders(),
 * which sends a one-time reminder for each appointment that has entered the
 * (default 24h) reminder window. The sweep is idempotent and self-gating via
 * business rules, so an hourly cadence simply means "send within the hour an
 * appointment crosses the 24h mark." Failures are logged and never crash the app.
 */
@Injectable()
export class NotificationsCronService {
  private readonly logger = new Logger(NotificationsCronService.name);

  constructor(private readonly notifications: NotificationsService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'appointment-reminders' })
  async runAppointmentReminders(): Promise<void> {
    try {
      const result = await this.notifications.sweepAppointmentReminders();
      if (result.sent > 0) {
        this.logger.log(
          `Appointment reminder sweep: ${result.sent} sent, ${result.skipped} skipped`,
        );
      }
    } catch (err) {
      this.logger.error(
        'Appointment reminder sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
