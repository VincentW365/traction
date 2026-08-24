import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ResourceAdminService } from '../resource-admin.service';

/**
 * CR-2026-095 — "we opened Bay 6" is an application action, and these tests pin the
 * guarantees that make that safe: validation the backend owns, statuses the
 * scheduler respects, retirement that keeps history, deletion that only ever
 * removes something never used, and a concurrency check so two managers cannot
 * silently overwrite each other.
 */

const SITE = 'site-1';

function build(overrides: Record<string, any> = {}) {
  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ id: SITE })) },
    workResource: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => ({ id: 'res-1', ...data })),
      update: vi.fn(async ({ data }: any) => ({ id: 'res-1', ...data })),
      delete: vi.fn(async () => ({})),
    },
    resourceOperationalStatus: {
      upsert: vi.fn(async ({ update }: any) => ({ id: 'ops-1', ...update })),
      deleteMany: vi.fn(async () => ({})),
    },
    resourceReservation: { count: vi.fn(async () => 0) },
    technicianAssignment: { count: vi.fn(async () => 0) },
    resourceOccupancy: {
      findUnique: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({})),
    },
    auditLog: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...overrides,
  };
  const audit = { log: vi.fn(async () => ({})) };
  return { service: new ResourceAdminService(prisma as any, audit as any), prisma, audit };
}

const EXISTING = {
  id: 'res-1',
  siteId: SITE,
  code: 'BAY-1',
  name: 'Bay 1',
  resourceCategory: 'BAY',
  isActive: true,
  retiredAt: null,
  updatedAt: new Date('2026-08-22T10:00:00Z'),
  supportsSedan: true,
  supportsSuv: true,
  occupancy: null,
  operationalStatus: null,
};

describe('creation is validated server-side', () => {
  it('creates a bay with sensible defaults and audits it', async () => {
    const h = build();
    const r = await h.service.create(SITE, { code: 'bay-6', name: 'Bay 6', resourceCategory: 'BAY' }, 'mgr-1');

    expect(r.code).toBe('BAY-6'); // normalised, so BAY-6 and bay-6 cannot coexist
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESOURCE_CREATE' }));
  });

  it('rejects a duplicate code at the same site', async () => {
    const h = build({
      site: { findUnique: vi.fn(async () => ({ id: SITE })) },
      workResource: {
        findUnique: vi.fn(async () => ({ id: 'other', retiredAt: null })),
        create: vi.fn(),
      },
    });
    await expect(
      h.service.create(SITE, { code: 'BAY-1', name: 'Bay 1 again', resourceCategory: 'BAY' }, 'mgr-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to reuse a RETIRED resource code — two histories must not merge', async () => {
    const h = build({
      site: { findUnique: vi.fn(async () => ({ id: SITE })) },
      workResource: {
        findUnique: vi.fn(async () => ({ id: 'old', retiredAt: new Date() })),
        create: vi.fn(),
      },
    });
    await expect(
      h.service.create(SITE, { code: 'BAY-1', name: 'New Bay', resourceCategory: 'BAY' }, 'mgr-1'),
    ).rejects.toThrow(/retired/i);
  });

  it('rejects blank names, invalid capacity, unknown types and a class-less resource', async () => {
    const h = build();
    const base = { code: 'X1', name: 'X', resourceCategory: 'BAY' };

    await expect(h.service.create(SITE, { ...base, name: '  ' }, 'u')).rejects.toThrow(/name/i);
    await expect(h.service.create(SITE, { ...base, capacity: 0 }, 'u')).rejects.toThrow(/capacity/i);
    await expect(h.service.create(SITE, { ...base, capacity: -3 }, 'u')).rejects.toThrow(/capacity/i);
    await expect(
      h.service.create(SITE, { ...base, resourceCategory: 'TELEPORTER' }, 'u'),
    ).rejects.toThrow(/not a resource type/i);
    await expect(
      h.service.create(SITE, { ...base, supportsSedan: false, supportsSuv: false }, 'u'),
    ).rejects.toThrow(/at least one vehicle class/i);
  });
});

describe('editing', () => {
  it('changes name and capabilities, auditing only the diff', async () => {
    const h = build({
      workResource: {
        findUnique: vi.fn(async () => EXISTING),
        update: vi.fn(async ({ data }: any) => ({ ...EXISTING, ...data })),
      },
    });
    await h.service.update('res-1', { name: 'Bay One', supportsSuv: false }, 'mgr-1');

    const call = (h.audit.log.mock.calls[0] as unknown as any[])[0];
    expect(call.action).toBe('RESOURCE_UPDATE');
    expect(call.beforeJson).toEqual({ name: 'Bay 1', supportsSuv: true });
    expect(call.afterJson).toEqual({ name: 'Bay One', supportsSuv: false });
  });

  it('detects a stale concurrent edit instead of overwriting it', async () => {
    const h = build({
      workResource: { findUnique: vi.fn(async () => EXISTING), update: vi.fn() },
    });
    await expect(
      h.service.update('res-1', { name: 'X' }, 'mgr-2', '2026-08-22T09:00:00.000Z'),
    ).rejects.toThrow(/changed by another user/i);
    expect(h.prisma.workResource.update).not.toHaveBeenCalled();
  });
});

describe('operational status', () => {
  it('needs a reason to take a resource out of service', async () => {
    const h = build({
      workResource: { findUnique: vi.fn(async () => EXISTING) },
    });
    await expect(
      h.service.setStatus('res-1', { status: 'MAINTENANCE' }, 'mgr-1'),
    ).rejects.toThrow(/reason/i);
  });

  it('records the graded status with the boolean kept in lockstep', async () => {
    const h = build({
      workResource: { findUnique: vi.fn(async () => EXISTING) },
    });
    await h.service.setStatus('res-1', { status: 'MAINTENANCE', reason: 'Lift repair' }, 'mgr-1');

    const upsert = h.prisma.resourceOperationalStatus.upsert.mock.calls[0][0];
    expect(upsert.update.status).toBe('MAINTENANCE');
    expect(upsert.update.isOperational).toBe(false);
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RESOURCE_OPERATIONAL_STATUS_CHANGE' }),
    );
  });

  it('returning to AVAILABLE clears the reason', async () => {
    const h = build({ workResource: { findUnique: vi.fn(async () => EXISTING) } });
    await h.service.setStatus('res-1', { status: 'AVAILABLE' }, 'mgr-1');
    const upsert = h.prisma.resourceOperationalStatus.upsert.mock.calls[0][0];
    expect(upsert.update.isOperational).toBe(true);
    expect(upsert.update.reason).toBeNull();
  });
});

describe('retirement keeps history; deletion is for the never-used', () => {
  it('retires with a reason, disabling scheduling and the board', async () => {
    const h = build({
      workResource: {
        findUnique: vi.fn(async () => EXISTING),
        update: vi.fn(async ({ data }: any) => ({ ...EXISTING, ...data })),
      },
    });
    await h.service.retire('res-1', 'Structural damage', 'mgr-1');

    const data = h.prisma.workResource.update.mock.calls[0][0].data;
    expect(data.retiredAt).toBeInstanceOf(Date);
    expect(data.isActive).toBe(false);
    expect(data.schedulingEnabled).toBe(false);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESOURCE_RETIRE' }));
  });

  it('refuses to retire while a vehicle is on it or bookings point at it', async () => {
    const occupied = build({
      workResource: {
        findUnique: vi.fn(async () => ({ ...EXISTING, occupancy: { status: 'OCCUPIED' } })),
      },
    });
    await expect(occupied.service.retire('res-1', 'reason', 'mgr-1')).rejects.toThrow(/vehicle on it/i);

    const booked = build({
      workResource: { findUnique: vi.fn(async () => EXISTING) },
      resourceReservation: { count: vi.fn(async () => 4) },
    });
    await expect(booked.service.retire('res-1', 'reason', 'mgr-1')).rejects.toThrow(/4 upcoming/i);
  });

  it('hard-deletes only a resource that was never referenced', async () => {
    const h = build({
      workResource: { findUnique: vi.fn(async () => EXISTING), delete: vi.fn(async () => ({})) },
    });
    const r = await h.service.deleteIfUnused('res-1', 'mgr-1');
    expect(r.deleted).toBe(true);
  });

  it('refuses to delete anything with operational history — retire instead', async () => {
    const h = build({
      workResource: { findUnique: vi.fn(async () => EXISTING), delete: vi.fn() },
      technicianAssignment: { count: vi.fn(async () => 12) },
    });
    await expect(h.service.deleteIfUnused('res-1', 'mgr-1')).rejects.toThrow(/retire it instead/i);
    expect(h.prisma.workResource.delete).not.toHaveBeenCalled();
  });
});

describe('overview', () => {
  it('counts by state, and sedan/SUV bays separately', async () => {
    const mk = (over: any) => ({
      ...EXISTING, id: over.code, ...over,
    });
    const h = build({
      workResource: {
        findMany: vi.fn(async () => [
          mk({ code: 'B1', occupancy: { status: 'OCCUPIED' } }),
          mk({ code: 'B2', operationalStatus: { status: 'MAINTENANCE' } }),
          mk({ code: 'B3', supportsSuv: false }),
          mk({ code: 'B4', retiredAt: new Date() }),
          mk({ code: 'J1', resourceCategory: 'LIGHT_SLOT' }),
        ]),
      },
    });
    const o = await h.service.overview(SITE);

    expect(o.totalActive).toBe(4);
    expect(o.inUse).toBe(1);
    expect(o.maintenance).toBe(1);
    expect(o.retired).toBe(1);
    expect(o.sedanBays).toBe(3);
    expect(o.suvBays).toBe(2); // B3 is sedan-only, B4 retired, J1 not a bay
  });
});
