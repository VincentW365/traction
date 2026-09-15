import { describe, it, expect, vi } from 'vitest';
import { CustomersService } from '../customers.service';

const customerRow = {
  id: 'c1', customerNumber: 'CUST-000123', firstName: 'Jane', lastName: 'Doe',
  phone: '8763341234', email: 'jane@example.test', loyaltyNumber: 'LOY-1', loyaltyMember: true, notes: 'import:abc; raw="DOE, JANE"',
  notificationOptInSms: true, notificationOptInEmail: false, createdAt: new Date('2026-01-01'),
};

describe('CustomersService.search — privacy-safe list', () => {
  it('returns list items with vehicleCount + lastVisitAt and NO phone', async () => {
    const prisma: any = {
      customer: {
        findMany: vi.fn(async () => [
          { ...customerRow, _count: { vehicles: 2 }, serviceVisits: [{ checkedInAt: new Date('2026-06-01'), arrivalAt: null, createdAt: new Date('2026-05-30') }] },
        ]),
      },
    };
    const svc = new CustomersService(prisma);
    const res = await svc.search('doe');
    expect(JSON.stringify(res)).not.toContain('phone');
    expect(JSON.stringify(res)).not.toContain('8763341234');
    expect(res[0]).toMatchObject({ id: 'c1', vehicleCount: 2, hasLoyalty: true });
    expect(res[0].lastVisitAt).toEqual(new Date('2026-06-01'));
  });

  // CR-2026-027 / CR-2026-106 — separator-insensitive vehicle-code match now comes
  // from the shared where-builder (common/helpers/search-where).
  const whereJson = (prisma: any) => JSON.stringify(prisma.customer.findMany.mock.calls[0][0].where);

  it('adds a normalized vehicleCode clause so SC-1211KC / SC1211KC / 1211KC all match', async () => {
    const prisma: any = { customer: { findMany: vi.fn(async () => []) } };
    await new CustomersService(prisma).search('SC-1211KC');
    expect(whereJson(prisma)).toContain('"vehicleCode":{"contains":"SC1211KC","mode":"insensitive"}');
    expect(whereJson(prisma)).toContain('"plateNumber":{"contains":"SC1211KC","mode":"insensitive"}');
  });

  it('omits the vehicle clause for a 1-char query and keeps the deterministic order + cap', async () => {
    const prisma: any = { customer: { findMany: vi.fn(async () => []) } };
    await new CustomersService(prisma).search('a');
    const args = prisma.customer.findMany.mock.calls[0][0];
    expect(JSON.stringify(args.where)).not.toContain('vehicles');
    expect(args.take).toBe(50);
    expect(args.orderBy).toEqual([{ lastName: 'asc' }, { firstName: 'asc' }, { customerNumber: 'asc' }]);
  });

  it('CR-2026-106: "Vincent Wilson" requires every token to match first OR last name', async () => {
    const prisma: any = { customer: { findMany: vi.fn(async () => []) } };
    await new CustomersService(prisma).search('Vincent Wilson');
    const j = whereJson(prisma);
    expect(j).toContain('"contains":"Vincent"');
    expect(j).toContain('"contains":"Wilson"');
    expect(j).not.toContain('"contains":"Vincent Wilson"');
  });

  it('CR-2026-106: a formatted phone searches the stored digits by last-7', async () => {
    const prisma: any = { customer: { findMany: vi.fn(async () => []) } };
    await new CustomersService(prisma).search('(876) 555-1234');
    expect(whereJson(prisma)).toContain('"phone":{"contains":"5551234"}');
  });

  it('CR-2026-106: create stores the phone digits-only', async () => {
    const prisma: any = {
      $transaction: vi.fn(async (cb: any) => cb(prisma)),
      $queryRaw: vi.fn(async () => [{ next_val: 44 }]),
      customer: { create: vi.fn(async ({ data }: any) => ({ ...customerRow, ...data, vehicles: [] })), findMany: vi.fn(async () => []) },
    };
    const svc = new CustomersService(prisma);
    await svc.create({ firstName: 'Vincent', lastName: 'Wilson', phone: '876-555-1234' } as any);
    const data = prisma.customer.create.mock.calls[0][0].data;
    expect(data.phone).toBe('8765551234');
  });
});

describe('CustomersService.directory — raw SQL, paginated, no phone', () => {
  it('maps rows, returns total + default limit/offset', async () => {
    const prisma: any = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'c1', customer_number: 'CUST-000001', first_name: 'Amy', last_name: 'Adams', has_loyalty: true, vehicle_count: 1, last_visit_at: null, missing_contact: false },
        ])
        .mockResolvedValueOnce([{ total: 1 }]),
    };
    const svc = new CustomersService(prisma);
    const res = await svc.directory({} as any);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.items[0]).toMatchObject({ id: 'c1', customerNumber: 'CUST-000001', hasLoyalty: true, vehicleCount: 1 });
    expect(JSON.stringify(res.items)).not.toContain('phone');
  });
});

describe('CustomersService.findById — detail with role-aware import meta', () => {
  function build() {
    const prisma: any = {
      customer: {
        findUnique: vi.fn(async () => ({
          ...customerRow,
          vehicles: [{ id: 'v1', vehicleCode: 'SC-X' }],
          _count: { vehicles: 1 },
          serviceVisits: [{ id: 'sv1', status: 'CLOSED', sourceType: 'WALKIN', checkedInAt: new Date('2026-06-01'), arrivalAt: null, createdAt: new Date('2026-05-30') }],
        })),
      },
      // CR-2026-097 — Customer 360 summary aggregates.
      serviceVisit: {
        aggregate: vi.fn(async () => ({ _count: 3, _max: { checkedInAt: new Date('2026-06-01'), createdAt: new Date('2026-06-01') } })),
        groupBy: vi.fn(async () => [{ vehicleId: 'v1', _count: 3, _max: { checkedInAt: new Date('2026-06-01'), createdAt: new Date('2026-06-01') } }]),
      },
      appointment: { findFirst: vi.fn(async () => null) },
    };
    return new CustomersService(prisma);
  }

  it('formats phones, strips import note, includes importMeta for admin/manager', async () => {
    const d: any = await build().findById('c1', true);
    expect(d.phones).toEqual(['876-334-1234']);
    expect(d.staffNotes).toBeNull();
    expect(d.importMeta).toEqual({ batchId: 'abc', rawName: 'DOE, JANE' });
    expect(d.vehicleCount).toBe(1);
    expect(d.recentVisits[0]).toMatchObject({ id: 'sv1', status: 'CLOSED', sourceType: 'WALKIN' });
  });

  it('omits importMeta for non-admin', async () => {
    const d: any = await build().findById('c1', false);
    expect('importMeta' in d).toBe(false);
  });

  it('throws NotFound when missing', async () => {
    const prisma: any = { customer: { findUnique: vi.fn(async () => null) } };
    await expect(new CustomersService(prisma).findById('nope', false)).rejects.toThrow(/not found/i);
  });
});

describe('CustomersService.create — number generator', () => {
  // CR-2026-023: dev-login sandbox tagging is handled centrally by the PrismaService
  // middleware now (see sandbox-tagging.middleware), not in this service.
  function buildCreate() {
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ next_val: 16 }]),
      customer: { create: vi.fn(async (args: any) => ({ id: 'cust-1', ...args.data })) },
    };
    const prisma: any = { $transaction: vi.fn(async (cb: any) => cb(tx)) };
    return { svc: new CustomersService(prisma), tx };
  }

  it('computes the next CUST- number from ^CUST-[0-9]+$ rows only (ignores imported C-…)', async () => {
    const { svc, tx } = buildCreate();
    await svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234' } as any);
    const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('');
    expect(sql).toContain("customer_number ~ '^CUST-[0-9]+$'");
    expect(tx.customer.create.mock.calls[0][0].data.customerNumber).toBe('CUST-000016');
  });

  it('persists the loyaltyMember flag; defaults to false when absent (CR-2026-050)', async () => {
    const a = buildCreate();
    await a.svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234', loyaltyMember: true } as any);
    expect(a.tx.customer.create.mock.calls[0][0].data.loyaltyMember).toBe(true);

    const b = buildCreate();
    await b.svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234', loyaltyMember: false } as any);
    expect(b.tx.customer.create.mock.calls[0][0].data.loyaltyMember).toBe(false);

    const c = buildCreate();
    await c.svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234' } as any);
    expect(c.tx.customer.create.mock.calls[0][0].data.loyaltyMember).toBe(false);
  });
});

describe('CustomersService.update — loyalty', () => {
  function build() {
    const prisma: any = {
      customer: {
        findUnique: vi.fn(async () => ({ id: 'c1' })),
        update: vi.fn(async (args: any) => ({ id: 'c1', ...args.data })),
      },
    };
    return { svc: new CustomersService(prisma), prisma };
  }

  it('sets loyaltyMember = true', async () => {
    const { svc, prisma } = build();
    await svc.update('c1', { loyaltyMember: true } as any);
    expect(prisma.customer.update.mock.calls[0][0].data.loyaltyMember).toBe(true);
  });

  it('sets loyaltyMember = false', async () => {
    const { svc, prisma } = build();
    await svc.update('c1', { loyaltyMember: false } as any);
    expect(prisma.customer.update.mock.calls[0][0].data.loyaltyMember).toBe(false);
  });

  it('leaves loyalty untouched when not provided', async () => {
    const { svc, prisma } = build();
    await svc.update('c1', { firstName: 'X' } as any);
    expect('loyaltyMember' in prisma.customer.update.mock.calls[0][0].data).toBe(false);
  });
});
