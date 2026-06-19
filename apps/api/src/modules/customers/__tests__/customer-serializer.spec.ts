import { describe, it, expect } from 'vitest';
import {
  toCustomerListItem,
  toCustomerDetail,
  mapDirectoryRow,
  resolveDirectoryOrder,
  type CustomerCore,
  type DirectoryRawRow,
} from '../customer-serializer';

const base: CustomerCore = {
  id: 'c1',
  customerNumber: 'CUST-000123',
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '8763341234',
  email: 'jane@example.test',
  loyaltyMember: true,
  notes: 'import:10b5c669-06b7-4d14-937a-5aab95c2c013; raw="DOE, JANE"',
  notificationOptInSms: true,
  notificationOptInEmail: false,
  createdAt: new Date('2026-01-01'),
};

describe('toCustomerListItem — privacy-safe list shape', () => {
  it('NEVER exposes phone, notes, or loyaltyNumber; derives badges', () => {
    const item = toCustomerListItem(base, { vehicleCount: 2, lastVisitAt: new Date('2026-06-01') });
    const json = JSON.stringify(item);
    expect(json).not.toContain('phone');
    expect(json).not.toContain('8763341234');
    expect(json).not.toContain('notes');
    expect(json).not.toContain('loyaltyNumber');
    expect(json).not.toContain('import:');
    expect(item).toMatchObject({
      id: 'c1', customerNumber: 'CUST-000123', firstName: 'Jane', lastName: 'Doe',
      hasLoyalty: true, vehicleCount: 2, missingContact: false,
    });
  });
  it('flags missingContact when no usable phone and no email', () => {
    const item = toCustomerListItem({ ...base, phone: '876', email: null, loyaltyMember: false }, { vehicleCount: 0, lastVisitAt: null });
    expect(item.hasLoyalty).toBe(false);
    expect(item.missingContact).toBe(true);
  });
});

describe('toCustomerDetail — formatted phones, staff notes, gated import meta', () => {
  it('formats phones, strips import note to staffNotes=null, includes importMeta only when allowed', () => {
    const withMeta = toCustomerDetail(base, { vehicles: [], recentVisits: [], vehicleCount: 0, includeImportMeta: true });
    expect(withMeta.phones).toEqual(['876-334-1234']);
    expect(withMeta.phonesFlagged).toBe(false);
    expect(withMeta.staffNotes).toBeNull(); // import note is not a staff note
    expect(withMeta.hasLoyalty).toBe(true);
    expect(withMeta.importMeta).toEqual({ batchId: '10b5c669-06b7-4d14-937a-5aab95c2c013', rawName: 'DOE, JANE' });
  });
  it('omits importMeta entirely for non-admin callers', () => {
    const noMeta = toCustomerDetail(base, { vehicles: [], recentVisits: [], vehicleCount: 0, includeImportMeta: false });
    expect('importMeta' in noMeta).toBe(false);
  });
  it('keeps a genuine staff note', () => {
    const d = toCustomerDetail({ ...base, notes: 'VIP — call before service' }, { vehicles: [], recentVisits: [], vehicleCount: 0, includeImportMeta: true });
    expect(d.staffNotes).toBe('VIP — call before service');
    expect(d.importMeta).toBeNull();
  });
  it('surfaces split phones with the flagged marker', () => {
    const d = toCustomerDetail({ ...base, phone: '87680142628763341234' }, { vehicles: [], recentVisits: [], vehicleCount: 0, includeImportMeta: false });
    expect(d.phones).toEqual(['876-801-4262', '876-334-1234']);
    expect(d.phonesFlagged).toBe(true);
  });
});

describe('resolveDirectoryOrder — whitelisted, never user input', () => {
  it('name (default) sorts last then first, both directions applied', () => {
    expect(resolveDirectoryOrder('name', 'asc')).toBe('c.last_name ASC, c.first_name ASC');
    expect(resolveDirectoryOrder('name', 'desc')).toBe('c.last_name DESC, c.first_name DESC');
    expect(resolveDirectoryOrder(undefined, undefined)).toBe('c.last_name ASC, c.first_name ASC');
  });
  it('customerNumber + lastVisit (NULLS LAST)', () => {
    expect(resolveDirectoryOrder('customerNumber', 'asc')).toBe('c.customer_number ASC');
    expect(resolveDirectoryOrder('lastVisit', 'desc')).toBe('last_visit_at DESC NULLS LAST');
  });
  it('unknown sortBy falls back to name', () => {
    expect(resolveDirectoryOrder('phone; DROP TABLE', 'asc')).toBe('c.last_name ASC, c.first_name ASC');
  });
});

describe('mapDirectoryRow — privacy-safe, coerces bigint count', () => {
  it('maps a raw row to a list item with no phone', () => {
    const row: DirectoryRawRow = {
      id: 'c1', customer_number: 'CUST-000123', first_name: 'Jane', last_name: 'Doe',
      has_loyalty: true, vehicle_count: 3n as unknown as bigint, last_visit_at: new Date('2026-06-01'), missing_contact: false,
    };
    const item = mapDirectoryRow(row);
    expect(item.vehicleCount).toBe(3);
    expect(item.hasLoyalty).toBe(true);
    expect(JSON.stringify(item)).not.toContain('phone');
  });
});
