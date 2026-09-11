import { describe, it, expect, vi } from 'vitest';
import { AppointmentsReportService } from '../appointments-report.service';
import { ETA_DEFAULTS } from '../../scheduling/eta/eta.config';

/** CR-2026-105c — the Appointments & Bookings definitions (AG-09), on fixture rows. */
const T = (iso: string) => new Date(iso);
const HOURS = { schedule: { '1': { open: '08:00', close: '17:00' } } }; // Monday 2026-09-14 only

function appt(over: Record<string, unknown>) {
  return {
    id: 'x',
    appointmentNumber: null,
    scheduledStartAt: T('2026-09-14T15:00:00Z'),
    scheduledEndAt: T('2026-09-14T16:20:00Z'),
    createdAt: T('2026-09-12T15:00:00Z'),
    status: 'CONFIRMED',
    sourceChannel: 'STAFF',
    services: [{ serviceType: { name: 'Oil Change', baseDurationMinutes: 30 } }],
    customer: { customerNumber: 'CUST-000001' },
    vehicle: { plateNumber: 'ABC1234', serviceClass: 'SEDAN_CLASS' },
    serviceVisit: null,
    ...over,
  };
}

function build() {
  const rows = [
    appt({
      id: 'a1', appointmentNumber: 'BK-B01-260914-001', status: 'CHECKED_IN',
      serviceVisit: {
        checkedInAt: T('2026-09-14T14:50:00Z'), currentEtaCompleteAt: T('2026-09-14T16:30:00Z'), status: 'CLOSED',
        serviceOrders: [{ startedAt: T('2026-09-14T15:10:00Z'), completedAt: T('2026-09-14T16:45:00Z'), status: 'CLOSED' }],
      },
    }),
    appt({ id: 'a2', sourceChannel: 'CUSTOMER_SELF_SERVICE', status: 'CANCELLED' }),
    appt({ id: 'a3', sourceChannel: 'CUSTOMER_SELF_SERVICE', status: 'MISSED', createdAt: T('2026-09-14T13:00:00Z') }),
  ];
  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ name: 'Main', timezone: 'America/Jamaica' })) },
    appointment: { findMany: vi.fn(async () => rows) },
    businessRuleConfig: {
      findFirst: vi.fn(async ({ where }: any) => (where.ruleKey === 'operating_hours' ? { valueJson: HOURS } : { valueJson: 15 })),
    },
    statusHistory: { findMany: vi.fn(async () => [{ entityId: 'a1', toStatus: 'RESCHEDULED' }, { entityId: 'a2', toStatus: 'CANCELLED' }]) },
    userAccount: { findUnique: vi.fn(async () => ({ fullName: 'Vincent' })) },
  };
  const eta = { loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: 2 })) };
  return { service: new AppointmentsReportService(prisma, eta as any), prisma };
}

describe('AppointmentsReportService', () => {
  it('computes the management definitions from source rows', async () => {
    const r = await build().service.getReport('site-1', '2026-09-14', '2026-09-14', 'u1');
    expect(r.meta.generatedBy).toBe('Vincent');
    expect(r.meta.period.days).toBe(1);
    const t = r.totals;
    expect(t).toMatchObject({ total: 3, staffCreated: 1, selfService: 2, cancelled: 1, rescheduled: 1, missed: 1, checkedIn: 1 });
    expect(t.cancellationRate).toBe(33.3);
    expect(t.rescheduleRate).toBe(33.3);
    expect(t.noShowRate).toBe(50); // 1 missed ÷ (1 missed + 1 checked in)
    expect(t.onTimeStarts).toBe(1); // started 15:10 ≤ 15:00 + 15 min
    expect(t.onTimeStartRate).toBe(100);
    expect(t.leadTimeMedianHours).toBe(48); // the one live booking
    // utilisation: one live 80-minute booking over 540 open minutes × 2 positions
    expect(t.bookedMinutes).toBe(80);
    expect(t.capacityMinutes).toBe(1080);
    expect(t.utilisationRate).toBe(7.4);
    expect(t.etaVariance).toMatchObject({ count: 1, medianAbsMinutes: 15, medianSignedMinutes: 15 }); // 16:45 actual vs 16:30 estimate
    expect(t.plannedVariance).toMatchObject({ count: 1, medianAbsMinutes: 25 }); // 16:45 vs 15:00 + 80
  });

  it('rows carry the per-appointment facts and by-day totals reconcile', async () => {
    const r = await build().service.getReport('site-1', '2026-09-14', '2026-09-14');
    expect(r.rows.map((x) => x.source)).toEqual(['STAFF', 'SELF_SERVICE', 'SELF_SERVICE']);
    expect(r.rows[0]).toMatchObject({ appointmentNumber: 'BK-B01-260914-001', reschedules: 1, onTime: true, varianceMinutes: 15, plannedMinutes: 80 });
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]).toMatchObject({ date: '2026-09-14', total: 3, selfService: 2, cancelled: 1, missed: 1, checkedIn: 1, bookedMinutes: 80, capacityMinutes: 1080 });
    expect(r.byDay.reduce((s, d) => s + d.total, 0)).toBe(r.totals.total);
  });
});
