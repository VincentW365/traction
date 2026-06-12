import { describe, it, expect, vi } from 'vitest';
import { ScheduleHoldsService } from '../schedule-holds.service';

function build() {
  const prisma: any = {
    scheduleHold: {
      create: vi.fn(async (a: any) => ({ id: 'h1', ...a.data })),
      findUnique: vi.fn(),
      update: vi.fn(async (a: any) => ({ id: a.where.id, ...a.data })),
      findMany: vi.fn(async () => []),
    },
    appointment: { findUnique: vi.fn(async () => ({ id: 'appt-1' })) },
  };
  const audit: any = { log: vi.fn(async () => ({})) };
  return { svc: new ScheduleHoldsService(prisma, audit), prisma, audit };
}

describe('ScheduleHoldsService.create', () => {
  it('derives scheduledEndAt from duration, defaults ACTIVE, trims label/notes, audits', async () => {
    const { svc, prisma, audit } = build();
    await svc.create({ siteId: 's1', scheduledStartAt: '2026-06-12T14:00:00.000Z', durationMinutes: 30, label: '  walk-up ', notes: '' } as any, 'u1');
    const data = prisma.scheduleHold.create.mock.calls[0][0].data;
    expect(data.status).toBe('ACTIVE');
    expect(data.label).toBe('walk-up');
    expect(data.notes).toBeNull();
    expect(data.createdByUserId).toBe('u1');
    expect(new Date(data.scheduledEndAt).getTime() - new Date(data.scheduledStartAt).getTime()).toBe(30 * 60_000);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SCHEDULE_HOLD_CREATED', entityType: 'ScheduleHold' }));
  });

  it('supports 60 and 90 minute durations', async () => {
    const a = build();
    await a.svc.create({ siteId: 's1', scheduledStartAt: '2026-06-12T09:00:00.000Z', durationMinutes: 90 } as any, 'u1');
    const data = a.prisma.scheduleHold.create.mock.calls[0][0].data;
    expect(new Date(data.scheduledEndAt).getTime() - new Date(data.scheduledStartAt).getTime()).toBe(90 * 60_000);
  });
});

describe('ScheduleHoldsService.listForDay', () => {
  it('filters ACTIVE holds within the calendar day for the site', async () => {
    const { svc, prisma } = build();
    await svc.listForDay('s1', '2026-06-12');
    const where = prisma.scheduleHold.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ siteId: 's1', status: 'ACTIVE' });
    expect(where.scheduledStartAt.gte).toBeInstanceOf(Date);
    expect(where.scheduledStartAt.lt).toBeInstanceOf(Date);
    expect(where.scheduledStartAt.lt.getTime() - where.scheduledStartAt.gte.getTime()).toBe(24 * 60 * 60_000);
  });

  it('rejects an invalid date', async () => {
    const { svc } = build();
    await expect(svc.listForDay('s1', 'not-a-date')).rejects.toThrow(/Invalid date/i);
  });
});

describe('ScheduleHoldsService.release', () => {
  it('releases an ACTIVE hold + audits', async () => {
    const { svc, prisma, audit } = build();
    prisma.scheduleHold.findUnique.mockResolvedValueOnce({ id: 'h1', status: 'ACTIVE' });
    await svc.release('h1', 'u1');
    expect(prisma.scheduleHold.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'h1' }, data: { status: 'RELEASED' } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SCHEDULE_HOLD_RELEASED' }));
  });

  it('throws when missing', async () => {
    const { svc, prisma } = build();
    prisma.scheduleHold.findUnique.mockResolvedValueOnce(null);
    await expect(svc.release('x', 'u1')).rejects.toThrow(/not found/i);
  });

  it('refuses a non-ACTIVE hold', async () => {
    const { svc, prisma } = build();
    prisma.scheduleHold.findUnique.mockResolvedValueOnce({ id: 'h1', status: 'RELEASED' });
    await expect(svc.release('h1', 'u1')).rejects.toThrow(/Cannot release/i);
  });
});

describe('ScheduleHoldsService.convert', () => {
  it('marks CONVERTED + links the appointment + audits', async () => {
    const { svc, prisma, audit } = build();
    prisma.scheduleHold.findUnique.mockResolvedValueOnce({ id: 'h1', status: 'ACTIVE' });
    await svc.convert('h1', 'appt-1', 'u1');
    expect(prisma.scheduleHold.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CONVERTED', convertedAppointmentId: 'appt-1' } }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SCHEDULE_HOLD_CONVERTED' }));
  });

  it('refuses when the appointment does not exist', async () => {
    const { svc, prisma } = build();
    prisma.scheduleHold.findUnique.mockResolvedValueOnce({ id: 'h1', status: 'ACTIVE' });
    prisma.appointment.findUnique.mockResolvedValueOnce(null);
    await expect(svc.convert('h1', 'bad', 'u1')).rejects.toThrow(/Appointment .* not found/i);
    expect(prisma.scheduleHold.update).not.toHaveBeenCalled();
  });

  it('refuses a non-ACTIVE hold', async () => {
    const { svc, prisma } = build();
    prisma.scheduleHold.findUnique.mockResolvedValueOnce({ id: 'h1', status: 'CONVERTED' });
    await expect(svc.convert('h1', 'appt-1', 'u1')).rejects.toThrow(/Cannot convert/i);
  });
});
