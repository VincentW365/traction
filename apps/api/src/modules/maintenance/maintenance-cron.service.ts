import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MaintenanceReminderService } from './maintenance-reminder.service';

/**
 * CR-2026-086 — the missing half of "tell the customer their next service is due".
 *
 * Everything else was already built: reminders are created automatically when staff
 * record a post-service recommendation, with send-date maths from the vehicle's own
 * mileage cadence, opt-in enforced, quiet hours respected, prior reminders
 * superseded, and both SMS and email dispatch wired. The one thing missing was
 * anything that CALLED it — `processScheduledReminders()` was reachable only from a
 * manual endpoint, so reminders piled up in SCHEDULED forever and no customer was
 * ever contacted. That is exactly the "set up with that in mind but not implemented"
 * the owner is seeing.
 *
 * Two deliberate safety choices:
 *
 * 1. **Off by default.** `maintenance_reminder_enabled` must be switched on in
 *    Settings. Turning a sweep like this on blind would message every opted-in
 *    customer holding a backlog of scheduled reminders in one go. The switch makes
 *    that a decision someone takes, having looked, rather than a side effect of a
 *    deploy. (Appointment reminders already work this way via
 *    `appointment_reminder_enabled`.)
 * 2. **Hourly, not daily.** `processScheduledReminders()` self-gates on quiet hours
 *    by returning early, so a daily job that happened to fire at 03:00 would never
 *    send anything at all.
 *
 * Failures are logged and never crash the app.
 */
@Injectable()
export class MaintenanceCronService {
  private readonly logger = new Logger(MaintenanceCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: MaintenanceReminderService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'maintenance-reminders' })
  async runMaintenanceReminders(): Promise<void> {
    try {
      if (!(await this.isEnabled())) return;

      const result = await this.reminders.processScheduledReminders();
      if (result.processed > 0 || result.skipped > 0) {
        this.logger.log(
          `Maintenance reminder sweep: ${result.processed} sent, ${result.skipped} skipped`,
        );
      }
    } catch (err) {
      this.logger.error(
        'Maintenance reminder sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Absent rule → disabled. An operator who has never seen this feature should not
   * have it start messaging their customers on the strength of a default.
   */
  private async isEnabled(): Promise<boolean> {
    const rule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'maintenance_reminder_enabled', effectiveTo: null },
    });
    return rule?.valueJson === true;
  }
}
