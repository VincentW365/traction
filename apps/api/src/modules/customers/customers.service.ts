import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, ServiceVisitStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerDirectoryDto } from './dto/customer-directory.dto';
import { liveCustomerWhere, liveVisitWhere, PLACEHOLDER_CUSTOMER_NUMBER } from '../../common/helpers/operational-scope';
import {
  customerSearchWhere,
  customerSearchSql,
  CUSTOMER_SEARCH_ORDER,
  CUSTOMER_SEARCH_TAKE,
} from '../../common/helpers/search-where';
import { phoneForStorage } from '../../common/helpers/search-terms';
import { normalizeCustomerEmail } from '../../common/helpers/customer-email';
import {
  toCustomerListItem,
  toCustomerDetail,
  mapDirectoryRow,
  resolveDirectoryOrder,
  type CustomerListItem,
  type CustomerDetail,
  type DirectoryRawRow,
} from './customer-serializer';
import { composeCustomerNotes } from './customer-format';

const RECENT_VISITS = 10;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    // CR-2026-106 — identity-review decisions are audited. Optional so the existing
    // one-argument spec construction keeps working.
    @Optional() private readonly audit?: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // CR-2026-106 — pending identity review (docs/121 §D "Identity"). A customer
  // created by self-service booking whose phone/email already belongs to another
  // record is listed here for a PERSON to decide; nothing is merged automatically.
  // ---------------------------------------------------------------------------

  async identityReview() {
    const rows = await this.prisma.customer.findMany({
      where: { identityReviewStatus: 'PENDING_REVIEW', testDataRunId: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        customerNumber: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        createdAt: true,
        possibleDuplicateOfId: true,
        vehicles: { select: { id: true, plateNumber: true, make: true, model: true }, take: 3 },
      },
    });
    const otherIds = rows.map((r) => r.possibleDuplicateOfId).filter((x): x is string => !!x);
    const others = otherIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: otherIds } },
          select: { id: true, customerNumber: true, firstName: true, lastName: true, phone: true, email: true, vehicles: { select: { id: true, plateNumber: true, make: true, model: true }, take: 3 } },
        })
      : [];
    const byId = new Map(others.map((o) => [o.id, o]));
    return rows.map((r) => {
      const other = r.possibleDuplicateOfId ? byId.get(r.possibleDuplicateOfId) ?? null : null;
      return {
        customer: { id: r.id, customerNumber: r.customerNumber, firstName: r.firstName, lastName: r.lastName, phone: r.phone, email: r.email, createdAt: r.createdAt, vehicles: r.vehicles },
        possibleDuplicate: other,
        matchedOn: other ? (other.phone === r.phone ? 'PHONE' : other.email && r.email && other.email.toLowerCase() === r.email.toLowerCase() ? 'EMAIL' : 'UNKNOWN') : 'UNKNOWN',
      };
    });
  }

  /**
   * A person decides: DISTINCT (keep both, clear the flag) or MERGE_INTO_EXISTING
   * (move the new record's vehicles + appointments to the existing customer and
   * retire the new record's flag with a pointer). Both are audited; nothing here
   * runs without an explicit decision.
   */
  async resolveIdentityReview(id: string, decision: 'DISTINCT' | 'MERGE_INTO_EXISTING', userId: string) {
    const row = await this.prisma.customer.findUnique({ where: { id }, select: { id: true, identityReviewStatus: true, possibleDuplicateOfId: true, customerNumber: true } });
    if (!row) throw new NotFoundException(`Customer ${id} not found`);
    if (row.identityReviewStatus !== 'PENDING_REVIEW') throw new BadRequestException('This customer is not awaiting identity review.');
    if (decision === 'DISTINCT') {
      await this.prisma.customer.update({ where: { id }, data: { identityReviewStatus: 'CONFIRMED_DISTINCT' } });
    } else {
      const targetId = row.possibleDuplicateOfId;
      if (!targetId) throw new BadRequestException('No existing record is linked to merge into.');
      await this.prisma.$transaction(async (tx) => {
        await tx.vehicle.updateMany({ where: { customerId: id }, data: { customerId: targetId } });
        await tx.appointment.updateMany({ where: { customerId: id }, data: { customerId: targetId } });
        await tx.serviceVisit.updateMany({ where: { customerId: id }, data: { customerId: targetId } });
        await tx.customer.update({
          where: { id },
          data: { identityReviewStatus: 'MERGED', notes: `Merged into ${targetId} by identity review (CR-2026-106). Record retained for audit.` },
        });
      });
    }
    await this.audit?.log({
      actorUserId: userId,
      action: AUDIT_ACTIONS.CUSTOMER_IDENTITY_REVIEW_RESOLVED,
      entityType: 'Customer',
      entityId: id,
      beforeJson: { identityReviewStatus: 'PENDING_REVIEW', possibleDuplicateOfId: row.possibleDuplicateOfId },
      afterJson: { decision, customerNumber: row.customerNumber },
    });
    return { id, decision };
  }

  /**
   * Search customers (front-desk/advisor). Search-first; returns the privacy-safe
   * list shape (CR-2026-021: phone/notes/loyaltyNumber are NOT returned in lists).
   * Excludes the BERT-HIST-UNKNOWN placeholder + test data by default (CR-2026-006/020).
   */
  async search(query: string, includeHistorical = false): Promise<CustomerListItem[]> {
    // CR-2026-106 — one shared where-builder (docs/121 §C1): tokenised names in
    // either order, digits-only phone, separator-insensitive plate/VIN/code.
    const match = customerSearchWhere(query);
    if (!match) return [];
    const rows = await this.prisma.customer.findMany({
      where: {
        AND: [match, liveCustomerWhere(includeHistorical)],
      },
      take: CUSTOMER_SEARCH_TAKE,
      orderBy: CUSTOMER_SEARCH_ORDER,
      include: {
        _count: { select: { vehicles: true } },
        serviceVisits: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { checkedInAt: true, arrivalAt: true, createdAt: true },
        },
      },
    });
    return rows.map((r) =>
      toCustomerListItem(r, {
        vehicleCount: r._count.vehicles,
        lastVisitAt: lastVisitDate(r.serviceVisits[0]),
      }),
    );
  }

  /**
   * Admin/Manager browse-all directory (CR-2026-021). Raw SQL for A–Z, sort,
   * filters (loyalty / has-vehicle / missing-contact) and server-side pagination.
   * Never returns phone/notes/loyaltyNumber (the SELECT omits them).
   */
  async directory(
    dto: CustomerDirectoryDto,
  ): Promise<{ items: CustomerListItem[]; total: number; limit: number; offset: number }> {
    const limit = dto.limit ?? 50;
    const offset = dto.offset ?? 0;

    const conds: Prisma.Sql[] = [
      Prisma.sql`c.customer_number <> ${PLACEHOLDER_CUSTOMER_NUMBER}`,
      Prisma.sql`c.test_data_run_id IS NULL`,
    ];
    if (dto.q && dto.q.trim()) {
      // CR-2026-106 — same semantics as the picker search, in SQL (docs/121 §C1).
      const sql = customerSearchSql(dto.q);
      if (sql !== Prisma.empty) conds.push(sql);
    }
    if (dto.letter) conds.push(Prisma.sql`c.last_name ILIKE ${dto.letter + '%'}`);
    if (dto.hasLoyalty === 'true') conds.push(Prisma.sql`c.loyalty_member = true`);
    if (dto.hasVehicle === 'true') conds.push(Prisma.sql`EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id)`);
    if (dto.missingContact === 'true') {
      conds.push(Prisma.sql`COALESCE(c.email,'') = '' AND length(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g')) < 7`);
    }
    const where = Prisma.join(conds, ' AND ');
    const orderBy = Prisma.raw(resolveDirectoryOrder(dto.sortBy, dto.sortOrder));

    const rows = await this.prisma.$queryRaw<DirectoryRawRow[]>(Prisma.sql`
      SELECT c.id, c.customer_number, c.first_name, c.last_name,
        c.loyalty_member AS has_loyalty,
        (SELECT count(*)::int FROM vehicles v WHERE v.customer_id = c.id) AS vehicle_count,
        (SELECT max(COALESCE(sv.checked_in_at, sv.arrival_at, sv.created_at))
           FROM service_visits sv WHERE sv.customer_id = c.id) AS last_visit_at,
        (COALESCE(c.email,'') = '' AND length(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g')) < 7) AS missing_contact
      FROM customers c
      WHERE ${where}
      ORDER BY ${orderBy}, c.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = await this.prisma.$queryRaw<{ total: number | bigint }[]>(Prisma.sql`
      SELECT count(*)::int AS total FROM customers c WHERE ${where}
    `);

    return { items: rows.map(mapDirectoryRow), total: Number(totalRows[0]?.total ?? 0), limit, offset };
  }

  /**
   * Create a new customer with an auto-generated customer_number (CUST-NNNNNN).
   */
  async create(data: CreateCustomerDto) {
    return this.prisma.$transaction(async (tx) => {
      // Only consider canonical CUST-<digits> numbers (ignore imported C-…, blanks,
      // and non-numeric suffixes) — otherwise the CAST throws and creation fails.
      // CR-2026-023: dev-login sandbox tagging is now handled centrally by the
      // PrismaService middleware, not here.
      const result = await tx.$queryRaw<{ next_val: number }[]>`
        SELECT COALESCE(
          MAX(CAST(SUBSTRING(customer_number FROM 6) AS INTEGER)), 0
        ) + 1 AS next_val
        FROM customers
        WHERE customer_number ~ '^CUST-[0-9]+$'
      `;
      const nextVal = result[0].next_val;
      const customerNumber = `CUST-${String(nextVal).padStart(6, '0')}`;

      return tx.customer.create({
        data: {
          customerNumber,
          firstName: data.firstName,
          lastName: data.lastName,
          // CR-2026-106 — stored digits-only so "876-555-1234" and "8765551234" are
          // one number for search; display formatting is applied on read.
          phone: phoneForStorage(data.phone),
          // CR-2026-113 — placeholder text ("N/A", "none", blank) is stored as
          // NULL, not as an address. Anything else must be a real address.
          email: normalizeCustomerEmail(data.email) ?? null,
          // CR-2026-050 — loyalty is a yes/no flag (no number).
          loyaltyMember: data.loyaltyMember ?? false,
          notificationOptInSms: data.notificationOptInSms ?? true,
          notificationOptInEmail: data.notificationOptInEmail ?? true,
          notes: data.notes,
        },
      });
    });
  }

  /**
   * Customer detail (CR-2026-021): formatted/split phones, loyalty, recent visit
   * history, staff-only notes. `includeImportMeta` (ADMIN/MANAGER) surfaces the
   * collapsed Import Metadata; everyone else never sees it.
   *
   * CR-2026-006 exemption retained: by-id lookup applies no operational-scope filter.
   */
  async findById(
    id: string,
    includeImportMeta = false,
  ): Promise<
    CustomerDetail & {
      stats: {
        totalVehicles: number;
        totalVisits: number;
        lastVisitAt: Date | null;
        nextAppointment: { id: string; scheduledStartAt: Date } | null;
      };
      vehicleStats: Record<string, { visitsCount: number; lastServiceAt: Date | null }>;
    }
  > {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        vehicles: true,
        _count: { select: { vehicles: true } },
        serviceVisits: {
          orderBy: { createdAt: 'desc' },
          take: RECENT_VISITS,
          select: { id: true, status: true, sourceType: true, checkedInAt: true, arrivalAt: true, createdAt: true },
        },
      },
    });
    if (!customer) {
      throw new NotFoundException(`Customer with id "${id}" not found`);
    }
    const recentVisits = customer.serviceVisits.map((v) => ({
      id: v.id,
      status: v.status,
      sourceType: v.sourceType,
      visitedAt: v.checkedInAt ?? v.arrivalAt ?? v.createdAt,
    }));

    // CR-2026-097 — Customer 360 summary: visit totals, per-vehicle history
    // counts, and the next upcoming appointment. One groupBy, no N+1.
    const [visitAgg, perVehicle, nextAppointment] = await Promise.all([
      this.prisma.serviceVisit.aggregate({
        where: { customerId: id, testDataRunId: null },
        _count: true,
        _max: { checkedInAt: true, createdAt: true },
      }),
      this.prisma.serviceVisit.groupBy({
        by: ['vehicleId'],
        where: { customerId: id, testDataRunId: null },
        _count: true,
        _max: { checkedInAt: true, createdAt: true },
      }),
      this.prisma.appointment.findFirst({
        where: {
          customerId: id,
          status: { in: ['DRAFT', 'CONFIRMED', 'RESCHEDULED'] },
          scheduledStartAt: { gte: new Date() },
        },
        orderBy: { scheduledStartAt: 'asc' },
        select: { id: true, scheduledStartAt: true },
      }),
    ]);
    const perVehicleMap = new Map(
      perVehicle.map((g) => [
        g.vehicleId,
        { visitsCount: g._count, lastServiceAt: g._max.checkedInAt ?? g._max.createdAt },
      ]),
    );

    const detail = toCustomerDetail(customer, {
      vehicles: customer.vehicles,
      recentVisits,
      vehicleCount: customer._count.vehicles,
      includeImportMeta,
    });
    return {
      ...detail,
      stats: {
        totalVehicles: customer._count.vehicles,
        totalVisits: visitAgg._count,
        lastVisitAt: visitAgg._max.checkedInAt ?? visitAgg._max.createdAt,
        nextAppointment,
      },
      vehicleStats: Object.fromEntries(perVehicleMap),
    };
  }

  /**
   * Full, paginated service history for one customer (CR-2026-030).
   *
   * Derives directly from ServiceVisit (no snapshot table). INCLUDES historical-
   * import visits — they are the customer's real past service and the basis for
   * mileage-pattern outreach — while EXCLUDING test-data sandbox rows
   * (`liveVisitWhere(true, false)` → `{ testDataRunId: null }`). Each row carries
   * the vehicle, mileage in/out, and the services performed (from the appointment
   * and/or the service orders).
   */
  async getServiceHistory(
    id: string,
    query: {
      limit?: number;
      offset?: number;
      // CR-2026-097 — Customer 360 / per-vehicle history filters.
      vehicleId?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      q?: string;
      sort?: 'newest' | 'oldest';
    } = {},
  ) {
    const take = Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 100);
    const skip = Math.max(Math.trunc(query.offset ?? 0), 0);
    const where: Prisma.ServiceVisitWhereInput = { customerId: id, ...liveVisitWhere(true, false) };

    if (query.vehicleId) where.vehicleId = query.vehicleId;
    if (query.status) {
      if (!(query.status in ServiceVisitStatus)) {
        throw new BadRequestException(`Unknown visit status "${query.status}"`);
      }
      where.status = query.status as ServiceVisitStatus;
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(`${query.dateFrom}T00:00:00.000Z`);
      if (query.dateTo) where.createdAt.lte = new Date(`${query.dateTo}T23:59:59.999Z`);
    }
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { visitNumber: { contains: q, mode: 'insensitive' } },
        { queueTicket: { ticketNumber: { contains: q, mode: 'insensitive' } } },
        { serviceOrders: { some: { items: { some: { serviceType: { name: { contains: q, mode: 'insensitive' } } } } } } },
        { vehicle: { plateNumber: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.serviceVisit.findMany({
        where,
        orderBy: { createdAt: query.sort === 'oldest' ? 'asc' : 'desc' },
        take,
        skip,
        include: {
          vehicle: { select: { id: true, vehicleCode: true, plateNumber: true, make: true, model: true, modelYear: true } },
          appointment: { select: { services: { select: { serviceType: { select: { name: true } } } } } },
          serviceOrders: { select: { items: { select: { serviceType: { select: { name: true } } } } } },
          // CR-2026-097 — availability flags so history rows can show at a glance
          // whether an inspection or job sheet exists for the visit.
          inspections: { select: { id: true, kind: true, status: true } },
          jobSheetDraft: { select: { id: true } },
        },
      }),
      this.prisma.serviceVisit.count({ where }),
    ]);

    const items = rows.map((v) => {
      const services = [
        ...(v.appointment?.services?.map((s) => s.serviceType.name) ?? []),
        ...v.serviceOrders.flatMap((so) => so.items.map((i) => i.serviceType.name)),
      ];
      const label = [v.vehicle?.modelYear, v.vehicle?.make, v.vehicle?.model].filter(Boolean).join(' ');
      return {
        id: v.id,
        visitNumber: v.visitNumber,
        visitedAt: v.checkedInAt ?? v.arrivalAt ?? v.createdAt,
        status: v.status,
        sourceType: v.sourceType,
        mileageIn: v.mileageIn,
        mileageOut: v.mileageOut,
        vehicle: v.vehicle
          ? { id: v.vehicle.id, vehicleCode: v.vehicle.vehicleCode, plateNumber: v.vehicle.plateNumber, label: label || null }
          : null,
        services: [...new Set(services)],
        inspections: v.inspections.map((i) => ({ id: i.id, kind: i.kind, status: i.status })),
        hasJobSheet: !!v.jobSheetDraft,
      };
    });

    return { items, total, limit: take, offset: skip };
  }

  /**
   * Partial update of a customer record.
   */
  async update(id: string, data: UpdateCustomerDto) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Customer with id "${id}" not found`);
    }
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.phone !== undefined && { phone: phoneForStorage(data.phone) }),
        ...(data.email !== undefined && { email: normalizeCustomerEmail(data.email) ?? null }),
        // CR-2026-050 — loyalty is a yes/no flag.
        ...(data.loyaltyMember !== undefined && { loyaltyMember: data.loyaltyMember }),
        ...(data.notificationOptInSms !== undefined && { notificationOptInSms: data.notificationOptInSms }),
        ...(data.notificationOptInEmail !== undefined && { notificationOptInEmail: data.notificationOptInEmail }),
        // CR-2026-060 — editable staff notes; preserve any import tag verbatim so the
        // import rollback (which matches the tag as a substring) still works.
        ...(data.notes !== undefined && { notes: composeCustomerNotes(existing.notes, data.notes) }),
      },
    });
  }
}

function lastVisitDate(v: { checkedInAt: Date | null; arrivalAt: Date | null; createdAt: Date } | undefined): Date | null {
  if (!v) return null;
  return v.checkedInAt ?? v.arrivalAt ?? v.createdAt;
}
