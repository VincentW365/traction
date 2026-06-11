import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomersService } from '../customers.service';
import { PLACEHOLDER_CUSTOMER_NUMBER } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — customer search excludes the historical placeholder customer
 * (customerNumber === 'BERT-HIST-UNKNOWN') by default; includeHistorical=true
 * removes the filter. findById is intentionally exempt (by-id lookup).
 *
 * CR-2026-020 — the live filter now ALSO excludes test-data customers by default
 * (`testDataRunId: null`); a no-op until a test run exists.
 */
function buildService() {
  const prisma: any = {
    customer: { findMany: vi.fn(async () => []) },
  };
  return { service: new CustomersService(prisma as any), prisma };
}

function liveClause(where: any) {
  // search() builds where.AND = [{ OR: [...] }, liveCustomerWhere(...)]
  return where.AND[where.AND.length - 1];
}

describe('CustomersService.search operational scope (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('excludes the placeholder customer by default', async () => {
    await h.service.search('smith');
    const where = h.prisma.customer.findMany.mock.calls[0][0].where;
    expect(liveClause(where)).toEqual({ customerNumber: { not: PLACEHOLDER_CUSTOMER_NUMBER }, testDataRunId: null });
  });

  it('includeHistorical=true removes the historical filter (test-data filter remains)', async () => {
    await h.service.search('smith', true);
    const where = h.prisma.customer.findMany.mock.calls[0][0].where;
    expect(liveClause(where)).toEqual({ testDataRunId: null });
  });
});
