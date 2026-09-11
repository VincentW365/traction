import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';

/**
 * CR-2026-105c — ARR-005 finally has a writer: an appointment nobody checked in
 * for becomes MISSED once `missed_threshold_min` has passed its scheduled start.
 * Before this, nothing ever wrote MISSED, so the no-show KPI was structurally
 * zero. Gated OFF by default (`appointment_auto_missed_enabled`) so enabling it
 * is a deliberate act — the first sweep classifies every historical backlog row.
 */
@Injectable()
export class AppointmentsCronService {
  private readonly logger = new Logger(AppointmentsCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statusHistory: StatusHistoryService,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'appointments-auto-missed' })
  async runAutoMissed(): Promise<void> {
    try {
      const result = await this.markMissed();
      if (result.marked > 0) this.logger.log(`Auto-missed sweep: ${result.marked} appointment(s) marked MISSED`);
    } catch (err) {
      this.logger.error('Auto-missed sweep failed', err instanceof Error ? err.stack : String(err));
    }
  }

  /** Idempotent: only appointments still in a pre-arrival status with no visit. */
  async markMissed(now: Date = new Date()): Promise<{ enabled: boolean; marked: number }> {
    const rules = await this.prisma.businessRuleConfig.findMany({
      where: { ruleKey: { in: ['appointment_auto_missed_enabled', 'missed_threshold_min'] }, effectiveTo: null },
      select: { ruleKey: true, valueJson: true, siteId: true },
    });
    const enabled = rules.some((r) => r.ruleKey === 'appointment_auto_missed_enabled' && r.valueJson === true);
    if (!enabled) return { enabled: false, marked: 0 };
    const threshold = rules.find((r) => r.ruleKey === 'missed_threshold_min' && typeof r.valueJson === 'number')?.valueJson as number | undefined;
    const cutoff = new Date(now.getTime() - (threshold ?? 30) * 60_000);

    const due = await this.prisma.appointment.findMany({
      where: {
        status: { in: ['DRAFT', 'CONFIRMED', 'RESCHEDULED'] },
        scheduledStartAt: { lt: cutoff },
        serviceVisit: null,
      },
      select: { id: true, status: true, scheduledStartAt: true, appointmentNumber: true },
      take: 500,
    });

    let marked = 0;
    for (const a of due) {
      const { count } = await this.prisma.appointment.updateMany({
        where: { id: a.id, status: a.status },
        data: { status: 'MISSED' },
      });
      if (count === 0) continue;
      marked += 1;
      await this.statusHistory.record({
        entityType: 'Appointment',
        entityId: a.id,
        fromStatus: a.status,
        toStatus: 'MISSED',
        reasonCode: 'AUTO_MISSED',
        notes: `No check-in ${threshold ?? 30} minutes after the scheduled start`,
      });
      await this.audit.log({
        actorUserId: null,
        action: AUDIT_ACTIONS.APPOINTMENT_MISSED,
        entityType: 'Appointment',
        entityId: a.id,
        beforeJson: { status: a.status, scheduledStartAt: a.scheduledStartAt },
        afterJson: { status: 'MISSED', appointmentNumber: a.appointmentNumber },
        reasonCode: 'AUTO_MISSED',
      });
    }
    return { enabled: true, marked };
  }
}
