import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { CreateScheduleHoldDto } from './dto/create-schedule-hold.dto';

/**
 * CR-2026-026 — Schedule Quick-Book Holds.
 * Advisory time blocks (no customer/vehicle/service). Deliberately ISOLATED from
 * the scheduling engine: this service never touches the queue, ETA, priority,
 * resource/bay matching, or check-in. It only creates/lists/releases/converts
 * holds and audits those transitions.
 */
@Injectable()
export class ScheduleHoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Create an ACTIVE hold; scheduledEndAt is derived from the chosen duration. */
  async create(dto: CreateScheduleHoldDto, actorUserId: string) {
    const start = new Date(dto.scheduledStartAt);
    const end = new Date(start.getTime() + dto.durationMinutes * 60_000);

    const hold = await this.prisma.scheduleHold.create({
      data: {
        siteId: dto.siteId,
        scheduledStartAt: start,
        scheduledEndAt: end,
        status: 'ACTIVE',
        label: dto.label?.trim() || null,
        notes: dto.notes?.trim() || null,
        createdByUserId: actorUserId,
      },
    });

    await this.audit.log({
      actorUserId,
      action: AUDIT_ACTIONS.SCHEDULE_HOLD_CREATED,
      entityType: 'ScheduleHold',
      entityId: hold.id,
      afterJson: {
        siteId: dto.siteId,
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
        durationMinutes: dto.durationMinutes,
      },
      reasonCode: 'SCHEDULE_HOLD_CREATE',
    });

    return hold;
  }

  /** List ACTIVE holds for a site on a given calendar day (start within the day). */
  async listForDay(siteId: string, date: string) {
    const dayStart = new Date(date);
    if (Number.isNaN(dayStart.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    return this.prisma.scheduleHold.findMany({
      where: { siteId, status: 'ACTIVE', scheduledStartAt: { gte: dayStart, lt: dayEnd } },
      orderBy: { scheduledStartAt: 'asc' },
    });
  }

  /** Manually release an ACTIVE hold (v1: no auto-expiry). */
  async release(id: string, actorUserId: string) {
    const existing = await this.prisma.scheduleHold.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Schedule hold ${id} not found`);
    if (existing.status !== 'ACTIVE') {
      throw new BadRequestException(`Cannot release a hold in status ${existing.status}`);
    }

    const hold = await this.prisma.scheduleHold.update({
      where: { id },
      data: { status: 'RELEASED' },
    });

    await this.audit.log({
      actorUserId,
      action: AUDIT_ACTIONS.SCHEDULE_HOLD_RELEASED,
      entityType: 'ScheduleHold',
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: 'RELEASED' },
      reasonCode: 'SCHEDULE_HOLD_RELEASE',
    });

    return hold;
  }

  /** Convert an ACTIVE hold: mark CONVERTED + link the appointment it became. */
  async convert(id: string, appointmentId: string, actorUserId: string) {
    const existing = await this.prisma.scheduleHold.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Schedule hold ${id} not found`);
    if (existing.status !== 'ACTIVE') {
      throw new BadRequestException(`Cannot convert a hold in status ${existing.status}`);
    }
    // Soft reference — verify the appointment exists so we don't link a bogus id.
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId }, select: { id: true } });
    if (!appt) throw new BadRequestException(`Appointment ${appointmentId} not found`);

    const hold = await this.prisma.scheduleHold.update({
      where: { id },
      data: { status: 'CONVERTED', convertedAppointmentId: appointmentId },
    });

    await this.audit.log({
      actorUserId,
      action: AUDIT_ACTIONS.SCHEDULE_HOLD_CONVERTED,
      entityType: 'ScheduleHold',
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: 'CONVERTED', convertedAppointmentId: appointmentId },
      reasonCode: 'SCHEDULE_HOLD_CONVERT',
    });

    return hold;
  }
}
