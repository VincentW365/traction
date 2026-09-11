import { describe, it, expect, vi } from 'vitest';
import { AppointmentsCronService } from '../appointments-cron.service';

/** CR-2026-105c — ARR-005's writer: rule-gated, idempotent, audited. */
function build(opts: { enabled: boolean; threshold?: number; due?: any[]; updateCount?: number }) {
  const prisma: any = {
    businessRuleConfig: {
      findMany: vi.fn(async () => [
        { ruleKey: 'appointment_auto_missed_enabled', valueJson: opts.enabled, siteId: 's' },
        ...(opts.threshold != null ? [{ ruleKey: 'missed_threshold_min', valueJson: opts.threshold, siteId: 's' }] : []),
      ]),
    },
    appointment: {
      findMany: vi.fn(async () => opts.due ?? []),
      updateMany: vi.fn(async () => ({ count: opts.updateCount ?? 1 })),
    },
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  return { service: new AppointmentsCronService(prisma, statusHistory as any, audit as any), prisma, statusHistory, audit };
}

describe('AppointmentsCronService.markMissed', () => {
  it('does nothing while the rule is off (deliberate enable)', async () => {
    const h = build({ enabled: false });
    expect(await h.service.markMissed()).toEqual({ enabled: false, marked: 0 });
    expect(h.prisma.appointment.findMany).not.toHaveBeenCalled();
  });

  it('marks un-checked-in appointments past the threshold, with history + audit (null actor)', async () => {
    const now = new Date('2026-09-11T15:00:00Z');
    const h = build({ enabled: true, threshold: 45, due: [{ id: 'a1', status: 'CONFIRMED', scheduledStartAt: new Date('2026-09-11T13:00:00Z'), appointmentNumber: 'BK-B01-260911-001' }] });
    const r = await h.service.markMissed(now);
    expect(r).toEqual({ enabled: true, marked: 1 });
    const where = h.prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.scheduledStartAt.lt.toISOString()).toBe('2026-09-11T14:15:00.000Z');
    expect(where.serviceVisit).toBeNull();
    expect(h.prisma.appointment.updateMany).toHaveBeenCalledWith({ where: { id: 'a1', status: 'CONFIRMED' }, data: { status: 'MISSED' } });
    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'a1', fromStatus: 'CONFIRMED', toStatus: 'MISSED', reasonCode: 'AUTO_MISSED' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, action: 'APPOINTMENT_MISSED', entityId: 'a1' }));
  });

  it('is idempotent: a row that changed status underneath is skipped without history', async () => {
    const h = build({ enabled: true, due: [{ id: 'a1', status: 'CONFIRMED', scheduledStartAt: new Date(0), appointmentNumber: null }], updateCount: 0 });
    expect(await h.service.markMissed()).toEqual({ enabled: true, marked: 0 });
    expect(h.statusHistory.record).not.toHaveBeenCalled();
  });
});
