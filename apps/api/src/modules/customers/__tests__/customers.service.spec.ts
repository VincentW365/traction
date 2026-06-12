import { describe, it, expect, vi } from 'vitest';
import { CustomersService } from '../customers.service';

// CR-2026-023: no sandbox context by default → create() behaves exactly as before.
const noSandbox = { getRunId: () => undefined } as any;

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
    const svc = new CustomersService(prisma, noSandbox);
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
    const svc = new CustomersService(prisma, noSandbox);
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
    return new CustomersService(prisma, noSandbox);
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
    await expect(new CustomersService(prisma, noSandbox).findById('nope', false)).rejects.toThrow(/not found/i);
  });
});

describe('CustomersService.create — dev-login sandbox tagging (CR-2026-023 spike)', () => {
  function buildCreate(sandboxRunId?: string) {
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ next_val: 1 }]),
      customer: { create: vi.fn(async (args: any) => ({ id: 'cust-1', ...args.data })) },
      externalSystemRef: { create: vi.fn(async () => ({ id: 'ref-1' })) },
    };
    const prisma: any = { $transaction: vi.fn(async (cb: any) => cb(tx)) };
    const sandbox: any = { getRunId: () => sandboxRunId };
    return { svc: new CustomersService(prisma, sandbox), tx };
  }

  it('tags the customer + writes a TEST_DATA_RUN manifest ref inside a sandbox session', async () => {
    const { svc, tx } = buildCreate('run-1');
    await svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234' } as any);
    expect(tx.customer.create.mock.calls[0][0].data.testDataRunId).toBe('run-1');
    expect(tx.externalSystemRef.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ system: 'TEST_DATA_RUN', externalId: 'run-1', entityType: 'Customer', entityId: 'cust-1' }) }),
    );
  });

  it('does NOT tag and writes NO manifest ref when there is no sandbox session (normal users unchanged)', async () => {
    const { svc, tx } = buildCreate(undefined);
    await svc.create({ firstName: 'A', lastName: 'B', phone: '8765551234' } as any);
    expect(tx.customer.create.mock.calls[0][0].data.testDataRunId).toBeUndefined();
    expect(tx.externalSystemRef.create).not.toHaveBeenCalled();
  });
});
