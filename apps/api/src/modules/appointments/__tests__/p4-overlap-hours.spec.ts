import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AppointmentsService } from '../appointments.service';

/**
 * P4(a) — appointment operating-hours + same-vehicle overlap guards.
 * Operating hours are enforced via validateOperatingHours (rejects outside the
 * configured site-local window). Overlap is enforced via validateNoVehicleOverlap
 * (rejects a second active appointment for the same vehicle in the window).
 * Mocked PrismaService; America/Jamaica is a fixed UTC-5 zone (no DST).
 */
function allDayHours() {
  const schedule: Record<string, { open: string; close: string }> = {};
  for (let d = 0; d <= 6; d++) schedule[String(d)] = { open: '08:00', close: '17:00' };
  return { valueJson: { schedule } };
}

function build(conflict: any = null) {
  const prisma: any = {
    businessRuleConfig: { findFirst: vi.fn(async () => allDayHours()) },
    site: { findUnique: vi.fn(async () => ({ timezone: 'America/Jamaica' })) },
    appointment: { findFirst: vi.fn(async () => conflict) },
  };
  const service = new AppointmentsService(prisma as any, { record: vi.fn() } as any, { log: vi.fn() } as any);
  return { service, prisma };
}

describe('P4(a) operating-hours guard', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('allows an appointment inside operating hours (10:00 local)', async () => {
    // 15:00Z == 10:00 America/Jamaica == within 08:00–17:00
    await expect((h.service as any).validateOperatingHours(new Date('2026-06-15T15:00:00Z'), 's1')).resolves.toBeUndefined();
  });

  it('rejects an appointment outside operating hours (18:00 local, after close)', async () => {
    // 23:00Z == 18:00 America/Jamaica == after 17:00 close
    await expect((h.service as any).validateOperatingHours(new Date('2026-06-15T23:00:00Z'), 's1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('P4(a) same-vehicle overlap guard', () => {
  it('rejects when an overlapping active appointment exists for the vehicle', async () => {
    const h = build({ id: 'a2', scheduledStartAt: new Date('2026-06-15T15:30:00Z') });
    await expect(
      (h.service as any).validateNoVehicleOverlap('v1', 's1', new Date('2026-06-15T15:00:00Z'), new Date('2026-06-15T16:00:00Z')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes when there is no overlapping appointment', async () => {
    const h = build(null);
    await expect(
      (h.service as any).validateNoVehicleOverlap('v1', 's1', new Date('2026-06-15T15:00:00Z'), new Date('2026-06-15T16:00:00Z')),
    ).resolves.toBeUndefined();
  });

  it('excludes the appointment being rescheduled from the overlap check', async () => {
    const h = build(null);
    await (h.service as any).validateNoVehicleOverlap('v1', 's1', new Date('2026-06-15T15:00:00Z'), new Date('2026-06-15T16:00:00Z'), 'self-id');
    const where = h.prisma.appointment.findFirst.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: 'self-id' });
    expect(where.vehicleId).toBe('v1');
    expect(where.status).toEqual({ notIn: ['CANCELLED', 'COMPLETED', 'MISSED'] });
  });
});
