import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerDirectoryDto } from './dto/customer-directory.dto';
import { liveCustomerWhere, PLACEHOLDER_CUSTOMER_NUMBER } from '../../common/helpers/operational-scope';
import {
  toCustomerListItem,
  toCustomerDetail,
  mapDirectoryRow,
  resolveDirectoryOrder,
  type CustomerListItem,
  type CustomerDetail,
  type DirectoryRawRow,
} from './customer-serializer';

const RECENT_VISITS = 10;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search customers (front-desk/advisor). Search-first; returns the privacy-safe
   * list shape (CR-2026-021: phone/notes/loyaltyNumber are NOT returned in lists).
   * Excludes the BERT-HIST-UNKNOWN placeholder + test data by default (CR-2026-006/020).
   */
  async search(query: string, includeHistorical = false): Promise<CustomerListItem[]> {
    const rows = await this.prisma.customer.findMany({
      where: {
        AND: [
          {
            OR: [
              { phone: { contains: query, mode: 'insensitive' } },
              { firstName: { contains: query, mode: 'insensitive' } },
              { lastName: { contains: query, mode: 'insensitive' } },
              { customerNumber: { contains: query, mode: 'insensitive' } },
              { email: { contains: query, mode: 'insensitive' } },
              { vehicles: { some: { plateNumber: { contains: query, mode: 'insensitive' } } } },
              { vehicles: { some: { vehicleCode: { contains: query, mode: 'insensitive' } } } },
              { vehicles: { some: { vin: { contains: query, mode: 'insensitive' } } } },
            ],
          },
          liveCustomerWhere(includeHistorical),
        ],
      },
      take: 20,
      orderBy: { lastName: 'asc' },
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
      const like = `%${dto.q.trim()}%`;
      conds.push(Prisma.sql`(
        c.first_name ILIKE ${like} OR c.last_name ILIKE ${like} OR c.customer_number ILIKE ${like}
        OR c.email ILIKE ${like} OR c.phone ILIKE ${like}
        OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id
          AND (v.plate_number ILIKE ${like} OR v.vehicle_code ILIKE ${like} OR v.vin ILIKE ${like}))
      )`);
    }
    if (dto.letter) conds.push(Prisma.sql`c.last_name ILIKE ${dto.letter + '%'}`);
    if (dto.hasLoyalty === 'true') conds.push(Prisma.sql`c.loyalty_number IS NOT NULL AND c.loyalty_number <> ''`);
    if (dto.hasVehicle === 'true') conds.push(Prisma.sql`EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id)`);
    if (dto.missingContact === 'true') {
      conds.push(Prisma.sql`COALESCE(c.email,'') = '' AND length(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g')) < 7`);
    }
    const where = Prisma.join(conds, ' AND ');
    const orderBy = Prisma.raw(resolveDirectoryOrder(dto.sortBy, dto.sortOrder));

    const rows = await this.prisma.$queryRaw<DirectoryRawRow[]>(Prisma.sql`
      SELECT c.id, c.customer_number, c.first_name, c.last_name,
        (c.loyalty_number IS NOT NULL AND c.loyalty_number <> '') AS has_loyalty,
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
          phone: data.phone,
          email: data.email,
          // Optional loyalty number; trimmed, empty → null (presence = loyalty member).
          loyaltyNumber: data.loyaltyNumber?.trim() ? data.loyaltyNumber.trim() : null,
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
  async findById(id: string, includeImportMeta = false): Promise<CustomerDetail> {
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
    return toCustomerDetail(customer, {
      vehicles: customer.vehicles,
      recentVisits,
      vehicleCount: customer._count.vehicles,
      includeImportMeta,
    });
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
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.notificationOptInSms !== undefined && { notificationOptInSms: data.notificationOptInSms }),
        ...(data.notificationOptInEmail !== undefined && { notificationOptInEmail: data.notificationOptInEmail }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });
  }
}

function lastVisitDate(v: { checkedInAt: Date | null; arrivalAt: Date | null; createdAt: Date } | undefined): Date | null {
  if (!v) return null;
  return v.checkedInAt ?? v.arrivalAt ?? v.createdAt;
}
