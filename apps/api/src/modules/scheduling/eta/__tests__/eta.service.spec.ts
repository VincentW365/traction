import { describe, it, expect, vi } from 'vitest';
import { EtaService } from '../eta.service';

/**
 * CR-2026-105b — the loader half of the ETA service: rule resolution (incl.
 * RESOURCES capacity), and which visits count as occupying a service position.
 */

const T0 = new Date('2026-09-11T14:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function build(overrides: { rules?: any[]; visits?: any[]; capacitySum?: number | null } = {}) {
  const prisma: any = {
    businessRuleConfig: { findMany: vi.fn(async () => overrides.rules ?? []) },
    workResource: { aggregate: vi.fn(async () => ({ _sum: { capacity: overrides.capacitySum ?? null } })) },
    serviceVisit: { findMany: vi.fn(async () => overrides.visits ?? []) },
  };
  return { service: new EtaService(prisma), prisma };
}

describe('EtaService.loadRules', () => {
  it('FIXED mode uses the configured number and never queries resources', async () => {
    const h = build({ rules: [{ ruleKey: 'booking_max_concurrent_appointments', valueJson: 3, siteId: 's' }] });
    const cfg = await h.service.loadRules('s');
    expect(cfg.capacity).toBe(3);
    expect(h.prisma.workResource.aggregate).not.toHaveBeenCalled();
    // site-or-global, current rows only
    expect(h.prisma.businessRuleConfig.findMany.mock.calls[0][0].where).toMatchObject({ effectiveTo: null });
  });

  it('RESOURCES mode sums schedulable resource capacity, falling back to the number when none', async () => {
    const rules = [
      { ruleKey: 'booking_capacity_mode', valueJson: 'RESOURCES', siteId: 's' },
      { ruleKey: 'booking_max_concurrent_appointments', valueJson: 2, siteId: 's' },
    ];
    expect((await build({ rules, capacitySum: 5 }).service.loadRules('s')).capacity).toBe(5);
    expect((await build({ rules, capacitySum: null }).service.loadRules('s')).capacity).toBe(2);
  });
});

describe('EtaService.loadInService', () => {
  const order = (status: string, startedAt: Date | null, extra: Record<string, unknown> = {}) => ({
    status,
    startedAt,
    items: [{ estimateMinutes: 60, serviceType: { baseDurationMinutes: 60 } }],
    pauses: [],
    kpiSnapshot: null,
    ...extra,
  });

  it('scopes to live visits and skips visits with no live order (lifecycle leftovers)', async () => {
    const h = build({
      visits: [
        { id: 'real', status: 'IN_SERVICE', serviceOrders: [order('IN_PROGRESS', min(-20))] },
        { id: 'leftover', status: 'WAITING_PARTS', serviceOrders: [] },
      ],
    });
    const rows = await h.service.loadInService('s', T0, 80);
    expect(rows.map((r) => r.serviceVisitId)).toEqual(['real']);
    const where = h.prisma.serviceVisit.findMany.mock.calls[0][0].where;
    expect(where.siteId).toBe('s');
    expect(where.sourceType).toBeDefined(); // serviceVisitIsLive() applied
  });

  it('derives stage, start, holds and planned minutes (KPI standard preferred)', async () => {
    const h = build({
      visits: [
        {
          id: 'held',
          status: 'IN_SERVICE',
          serviceOrders: [
            order('PAUSED', min(-40), {
              pauses: [{ startedAt: min(-30), endedAt: min(-25) }, { startedAt: min(-10), endedAt: null }],
              kpiSnapshot: { standardMinutes: 90, customStandardMinutes: null },
            }),
          ],
        },
        { id: 'qc', status: 'QC', serviceOrders: [order('QC', min(-90))] },
        { id: 'fresh', status: 'IN_SERVICE', serviceOrders: [order('ASSIGNED', null)] },
      ],
    });
    const rows = await h.service.loadInService('s', T0, 80);
    const by = Object.fromEntries(rows.map((r) => [r.serviceVisitId, r]));
    expect(by.held).toMatchObject({ stage: 'HOLD', plannedMinutes: 90, closedPauseMinutes: 5, startedAt: min(-40) });
    expect(by.held.openPauseStartedAt).toEqual(min(-10));
    expect(by.qc.stage).toBe('QC');
    expect(by.fresh).toMatchObject({ stage: 'IN_PROGRESS', startedAt: T0, plannedMinutes: 60 });
  });
});
