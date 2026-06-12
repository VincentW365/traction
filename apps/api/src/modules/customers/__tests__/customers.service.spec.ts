import { describe, it, expect, vi } from 'vitest';
import { CustomersService } from '../customers.service';

const customerRow = {
  id: 'c1', customerNumber: 'CUST-000123', firstName: 'Jane', lastName: 'Doe',
  phone: '8763341234', email: 'jane@example.test', loyaltyNumber: 'LOY-1', notes: 'import:abc; raw="DOE, JANE"',
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

  it('persists an optional loyaltyNumber (trimmed); blank/absent → null', async () => {
    const a = buildCreate();
    await a.svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234', loyaltyNumber: '  LOY-9  ' } as any);
    expect(a.tx.customer.create.mock.calls[0][0].data.loyaltyNumber).toBe('LOY-9');

    const b = buildCreate();
    await b.svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234', loyaltyNumber: '   ' } as any);
    expect(b.tx.customer.create.mock.calls[0][0].data.loyaltyNumber).toBeNull();

    const c = buildCreate();
    await c.svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234' } as any);
    expect(c.tx.customer.create.mock.calls[0][0].data.loyaltyNumber).toBeNull();
  });
});
