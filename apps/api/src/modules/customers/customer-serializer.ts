/**
 * Customer response serializers (CR-2026-021). Pure mappers from Prisma rows to
 * API DTOs. Privacy is enforced HERE, server-side:
 *  - the list item NEVER includes phone / notes / loyaltyNumber,
 *  - the detail returns FORMATTED phones (split), staff-only notes, and includes
 *    import metadata ONLY when the caller is allowed (ADMIN/MANAGER).
 */
import { formatPhones, parseCustomerNotes } from './customer-format';

export interface CustomerCore {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  loyaltyNumber: string | null;
  notes: string | null;
  notificationOptInSms: boolean;
  notificationOptInEmail: boolean;
  createdAt: Date;
}

const hasText = (s: string | null | undefined): boolean => !!(s && s.trim());

// --- List item (search + directory) — phone/notes/loyaltyNumber intentionally omitted ---
export interface CustomerListItem {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  hasLoyalty: boolean;
  vehicleCount: number;
  lastVisitAt: Date | string | null;
  missingContact: boolean;
}

export function toCustomerListItem(
  c: CustomerCore,
  extra: { vehicleCount: number; lastVisitAt: Date | string | null },
): CustomerListItem {
  const fp = formatPhones(c.phone);
  return {
    id: c.id,
    customerNumber: c.customerNumber,
    firstName: c.firstName,
    lastName: c.lastName,
    hasLoyalty: hasText(c.loyaltyNumber),
    vehicleCount: extra.vehicleCount,
    lastVisitAt: extra.lastVisitAt ?? null,
    missingContact: fp.values.length === 0 && !hasText(c.email),
  };
}

// --- Detail ---
export interface CustomerDetail {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phones: string[];
  phonesFlagged: boolean;
  email: string | null;
  loyaltyNumber: string | null;
  hasLoyalty: boolean;
  notificationOptInSms: boolean;
  notificationOptInEmail: boolean;
  staffNotes: string | null;
  vehicleCount: number;
  vehicles: unknown[];
  recentVisits: unknown[];
  createdAt: Date;
  importMeta?: { batchId: string; rawName: string } | null;
}

// --- Directory (raw-SQL) row → list item + safe sort resolution ---
export interface DirectoryRawRow {
  id: string;
  customer_number: string;
  first_name: string;
  last_name: string;
  has_loyalty: boolean;
  vehicle_count: number | bigint;
  last_visit_at: Date | null;
  missing_contact: boolean;
}

export function mapDirectoryRow(r: DirectoryRawRow): CustomerListItem {
  return {
    id: r.id,
    customerNumber: r.customer_number,
    firstName: r.first_name,
    lastName: r.last_name,
    hasLoyalty: !!r.has_loyalty,
    vehicleCount: Number(r.vehicle_count),
    lastVisitAt: r.last_visit_at ?? null,
    missingContact: !!r.missing_contact,
  };
}

/** Whitelisted ORDER BY expression (never interpolates user input). */
export function resolveDirectoryOrder(sortBy?: string, sortOrder?: string): string {
  const dir = sortOrder === 'desc' ? 'DESC' : 'ASC';
  switch (sortBy) {
    case 'customerNumber':
      return `c.customer_number ${dir}`;
    case 'lastVisit':
      return `last_visit_at ${dir} NULLS LAST`;
    case 'name':
    default:
      return `c.last_name ${dir}, c.first_name ${dir}`;
  }
}

export function toCustomerDetail(
  c: CustomerCore,
  opts: { vehicles: unknown[]; recentVisits: unknown[]; vehicleCount: number; includeImportMeta: boolean },
): CustomerDetail {
  const fp = formatPhones(c.phone);
  const parsed = parseCustomerNotes(c.notes);
  const base: CustomerDetail = {
    id: c.id,
    customerNumber: c.customerNumber,
    firstName: c.firstName,
    lastName: c.lastName,
    phones: fp.values,
    phonesFlagged: fp.flagged,
    email: c.email ?? null,
    loyaltyNumber: c.loyaltyNumber ?? null,
    hasLoyalty: hasText(c.loyaltyNumber),
    notificationOptInSms: c.notificationOptInSms,
    notificationOptInEmail: c.notificationOptInEmail,
    staffNotes: parsed.staffNotes,
    vehicleCount: opts.vehicleCount,
    vehicles: opts.vehicles,
    recentVisits: opts.recentVisits,
    createdAt: c.createdAt,
  };
  if (opts.includeImportMeta) base.importMeta = parsed.importMeta;
  return base;
}
