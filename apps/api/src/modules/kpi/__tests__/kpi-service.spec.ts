import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KpiService } from '../kpi.service';

/**
 * CR-2026-088 — the KPI guards.
 *
 * These are the rules that make the measurement trustworthy rather than
 * self-reported. Each exists because without it the number could be improved
 * without doing the work faster.
 */
function build(overrides: Record<string, any> = {}) {
  const prisma: any = {
    serviceOrder: { findUnique: vi.fn(async () => null) },
    workOrderKpiSnapshot: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'snap-1' })),
      update: vi.fn(async (a: any) => ({ id: 'snap-1', ...a.data })),
    },
    kpiDelayEvent: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (a: any) => ({ id: 'delay-1', ...a.data })),
      update: vi.fn(async (a: any) => ({ id: 'delay-1', ...a.data })),
    },
    kpiPolicy: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    kpiServiceComponent: { findMany: vi.fn(async () => []) },
    technician: { findUnique: vi.fn(async () => null) },
    ...overrides,
  };
  const audit = { log: vi.fn(async () => ({})) };
  return { service: new KpiService(prisma as any, audit as any), prisma, audit };
}

const vehicle = (serviceClass: string | null) => ({
  serviceVisit: { vehicle: { serviceClass, plateNumber: 'ABC123' } },
});

describe('vehicle class must be confirmed before KPI work starts', () => {
  it('refuses an unclassified vehicle, naming the plate', async () => {
    const h = build({ serviceOrder: { findUnique: vi.fn(async () => vehicle(null)) } });
    await expect(h.service.assertVehicleClassConfirmed('so-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(h.service.assertVehicleClassConfirmed('so-1')).rejects.toThrow(/ABC123/);
  });

  it('refuses a vehicle still marked as needing review', async () => {
    const h = build({
      serviceOrder: { findUnique: vi.fn(async () => vehicle('UNKNOWN_REQUIRES_REVIEW')) },
    });
    await expect(h.service.assertVehicleClassConfirmed('so-1')).rejects.toThrow(
      /Sedan or an SUV/i,
    );
  });

  it('allows a confirmed Sedan or SUV', async () => {
    for (const cls of ['SEDAN_CLASS', 'SUV_CLASS']) {
      const h = build({ serviceOrder: { findUnique: vi.fn(async () => vehicle(cls)) } });
      await expect(h.service.assertVehicleClassConfirmed('so-1')).resolves.toBeUndefined();
    }
  });

  it('does not block a visit that has no vehicle at all', async () => {
    // A missing vehicle is a different problem; this gate is about classification.
    const h = build({ serviceOrder: { findUnique: vi.fn(async () => ({ serviceVisit: null })) } });
    await expect(h.service.assertVehicleClassConfirmed('so-1')).resolves.toBeUndefined();
  });
});

describe('a technician cannot approve their own exclusion', () => {
  const pendingDelay = {
    id: 'delay-1',
    technicianId: 'tech-1',
    approvalStatus: 'PENDING',
    requestedForExclusion: true,
    endedAt: new Date(),
    reasonCode: 'WAITING_FOR_PARTS',
    durationMinutes: 20,
  };

  it('refuses when the approver is the technician the delay belongs to', async () => {
    const h = build({
      kpiDelayEvent: {
        findUnique: vi.fn(async () => pendingDelay),
        update: vi.fn(async () => ({})),
      },
      technician: { findUnique: vi.fn(async () => ({ id: 'tech-1' })) },
    });

    await expect(
      h.service.decideDelay({ delayId: 'delay-1', approve: true, actorUserId: 'user-tech-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a supervisor, who holds no technician record', async () => {
    const h = build({
      kpiDelayEvent: {
        findUnique: vi.fn(async () => pendingDelay),
        update: vi.fn(async (a: any) => ({ id: 'delay-1', ...a.data })),
      },
      technician: { findUnique: vi.fn(async () => null) },
    });

    const out = await h.service.decideDelay({
      delayId: 'delay-1',
      approve: true,
      actorUserId: 'user-manager',
    });
    expect(out.approvalStatus).toBe('APPROVED');
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'KPI_DELAY_APPROVED' }),
    );
  });

  it('allows a different technician to approve', async () => {
    const h = build({
      kpiDelayEvent: {
        findUnique: vi.fn(async () => pendingDelay),
        update: vi.fn(async (a: any) => ({ id: 'delay-1', ...a.data })),
      },
      technician: { findUnique: vi.fn(async () => ({ id: 'tech-2' })) },
    });
    await expect(
      h.service.decideDelay({ delayId: 'delay-1', approve: true, actorUserId: 'user-tech-2' }),
    ).resolves.toMatchObject({ approvalStatus: 'APPROVED' });
  });

  it('requires a reason to reject', async () => {
    const h = build({
      kpiDelayEvent: { findUnique: vi.fn(async () => pendingDelay), update: vi.fn() },
      technician: { findUnique: vi.fn(async () => null) },
    });
    await expect(
      h.service.decideDelay({ delayId: 'delay-1', approve: false, actorUserId: 'u1' }),
    ).rejects.toThrow(/reason is required/i);
  });

  it('refuses to approve a delay that is still open', async () => {
    const h = build({
      kpiDelayEvent: {
        findUnique: vi.fn(async () => ({ ...pendingDelay, endedAt: null })),
        update: vi.fn(),
      },
      technician: { findUnique: vi.fn(async () => null) },
    });
    await expect(
      h.service.decideDelay({ delayId: 'delay-1', approve: true, actorUserId: 'u1' }),
    ).rejects.toThrow(/still open/i);
  });

  it('refuses a delay that was never submitted for exclusion', async () => {
    // Recording a delay for the record is not the same as claiming KPI relief.
    const h = build({
      kpiDelayEvent: {
        findUnique: vi.fn(async () => ({ ...pendingDelay, requestedForExclusion: false })),
        update: vi.fn(),
      },
      technician: { findUnique: vi.fn(async () => null) },
    });
    await expect(
      h.service.decideDelay({ delayId: 'delay-1', approve: true, actorUserId: 'u1' }),
    ).rejects.toThrow(/not submitted for KPI exclusion/i);
  });
});

describe('overlapping delays are refused', () => {
  it('rejects a delay that overlaps one already recorded', async () => {
    const h = build({
      kpiDelayEvent: {
        findMany: vi.fn(async () => [
          { startedAt: new Date('2026-08-21T09:00:00Z'), endedAt: new Date('2026-08-21T09:30:00Z') },
        ]),
        create: vi.fn(),
      },
    });

    await expect(
      h.service.recordDelay({
        serviceOrderId: 'so-1',
        reasonCode: 'WAITING_FOR_PARTS',
        startedAt: new Date('2026-08-21T09:15:00Z'),
        endedAt: new Date('2026-08-21T09:45:00Z'),
        recordedByUserId: 'u1',
      }),
    ).rejects.toThrow(/overlaps/i);
  });

  it('accepts a delay that merely touches the previous one', async () => {
    const h = build({
      kpiDelayEvent: {
        findMany: vi.fn(async () => [
          { startedAt: new Date('2026-08-21T09:00:00Z'), endedAt: new Date('2026-08-21T09:30:00Z') },
        ]),
        create: vi.fn(async (a: any) => ({ id: 'd2', ...a.data })),
      },
    });

    await expect(
      h.service.recordDelay({
        serviceOrderId: 'so-1',
        reasonCode: 'BAY_OR_EQUIPMENT_UNAVAILABLE',
        startedAt: new Date('2026-08-21T09:30:00Z'),
        endedAt: new Date('2026-08-21T10:00:00Z'),
        recordedByUserId: 'u1',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a delay that ends before it starts', async () => {
    const h = build();
    await expect(
      h.service.recordDelay({
        serviceOrderId: 'so-1',
        reasonCode: 'OTHER',
        startedAt: new Date('2026-08-21T10:00:00Z'),
        endedAt: new Date('2026-08-21T09:00:00Z'),
        recordedByUserId: 'u1',
      }),
    ).rejects.toThrow(/must end after it starts/i);
  });

  it('records a delay as PENDING even when exclusion is requested', async () => {
    const h = build();
    const out = await h.service.recordDelay({
      serviceOrderId: 'so-1',
      reasonCode: 'EXCEPTIONAL_THERMAL_SAFETY_HOLD',
      description: 'Exhaust too hot to work on safely; nothing else on this job to do.',
      startedAt: new Date('2026-08-21T09:00:00Z'),
      endedAt: new Date('2026-08-21T09:20:00Z'),
      requestedForExclusion: true,
      recordedByUserId: 'user-tech-1',
    });
    // A thermal hold is an exception that a supervisor must approve, never automatic.
    expect(out.approvalStatus).toBe('PENDING');
    expect(out.durationMinutes).toBe(20);
  });
});

describe('a benchmark cannot be set after the result is known', () => {
  it('refuses a custom standard on a finalised job', async () => {
    const h = build({
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => ({ id: 'snap-1', finalisedAt: new Date() })),
        update: vi.fn(),
      },
    });

    await expect(
      h.service.approveCustomStandard({
        serviceOrderId: 'so-1',
        standardMinutes: 150,
        reason: 'Unusual combination',
        actorUserId: 'u1',
      }),
    ).rejects.toThrow(/after the result is known/i);
  });

  it('requires a reason', async () => {
    const h = build({
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => ({ id: 'snap-1', finalisedAt: null })),
        update: vi.fn(),
      },
    });
    await expect(
      h.service.approveCustomStandard({
        serviceOrderId: 'so-1',
        standardMinutes: 150,
        reason: '  ',
        actorUserId: 'u1',
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  it('rejects a nonsensical standard', async () => {
    const h = build();
    for (const bad of [0, -30, 12.5]) {
      await expect(
        h.service.approveCustomStandard({
          serviceOrderId: 'so-1',
          standardMinutes: bad,
          reason: 'x',
          actorUserId: 'u1',
        }),
      ).rejects.toThrow(/positive number of minutes/i);
    }
  });

  it('records the approval with its reason on an unfinished job', async () => {
    const h = build({
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => ({
          id: 'snap-1',
          finalisedAt: null,
          standardMinutes: null,
          packageType: 'CUSTOM_UNBENCHMARKED',
        })),
        update: vi.fn(async (a: any) => ({ id: 'snap-1', ...a.data })),
      },
    });

    const out = await h.service.approveCustomStandard({
      serviceOrderId: 'so-1',
      standardMinutes: 210,
      reason: 'Gearbox strip agreed with the customer',
      actorUserId: 'user-manager',
    });

    expect(out.standardMinutes).toBe(210);
    expect(out.customStandardMinutes).toBe(210);
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KPI_CUSTOM_STANDARD_APPROVED',
        notes: 'Gearbox strip agreed with the customer',
      }),
    );
  });
});

describe('rework preserves the first result', () => {
  it('flags rework instead of overwriting a finalised snapshot', async () => {
    const update = vi.fn(async () => ({}));
    const h = build({
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => ({
          id: 'snap-1',
          finalisedAt: new Date(),
          hadRework: false,
          kpiCompletionMinutes: 95,
          adjustedTechnicianRating: 'EXCELLENT',
        })),
        update,
        create: vi.fn(),
      },
    });

    await h.service.captureSnapshotOnQc('so-1');

    // Only the rework flag moves — speed must never be improvable by reworking.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { hadRework: true } }),
    );
  });
});
