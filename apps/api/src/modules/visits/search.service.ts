import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { customerIdentityWhere, vehicleIdentityWhere } from '../../common/helpers/search-where';
import { parseSearchQuery } from '../../common/helpers/search-terms';

/**
 * CR-2026-097 — global record search.
 *
 * One box that accepts what staff actually hold in their hand: a name, a phone
 * number, a licence plate, a VIN, a visit/ticket number, an inspection number,
 * or a job-sheet number (JS-<visit>). Results are typed and carry enough
 * context to pick the right one. Test-tagged sandbox rows are excluded;
 * historical (imported) visits are INCLUDED — they are the archive.
 */

export interface SearchResults {
  query: string;
  customers: Array<{
    id: string; name: string; customerNumber: string; phone: string | null; email: string | null;
  }>;
  vehicles: Array<{
    id: string; label: string; plateNumber: string; vehicleCode: string;
    owner: { id: string; name: string } | null;
  }>;
  visits: Array<{
    id: string; visitNumber: string | null; status: string; visitedAt: Date;
    customer: string; vehicle: string;
  }>;
  inspections: Array<{
    id: string; inspectionNumber: string; kind: string; status: string; createdAt: Date;
    serviceVisitId: string; visitNumber: string | null;
  }>;
}

const TAKE = 5;

/**
 * The customer fields the search returns, declared once so the query and its
 * empty-result branch cannot describe different rows.
 */
const CUSTOMER_HIT_SELECT = {
  id: true,
  customerNumber: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
} satisfies Prisma.CustomerSelect;

type CustomerHit = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_HIT_SELECT }>;

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(rawQuery: string): Promise<SearchResults> {
    const q = (rawQuery ?? '').trim();
    const empty: SearchResults = { query: q, customers: [], vehicles: [], visits: [], inspections: [] };
    if (q.length < 2) return empty;

    // "JS-B01-260820-003" is the job sheet OF visit B01-260820-003.
    const jobSheetMatch = /^js-?(.+)$/i.exec(q);
    const visitNumberQuery = jobSheetMatch ? jobSheetMatch[1] : q;

    // CR-2026-106 — the shared parser/builders (docs/121 §C1): names in either
    // order, phone by digits only when the input IS a phone (a plate no longer
    // returns phone noise), plates/VINs separator-insensitive.
    const parsed = parseSearchQuery(q);
    const identity = customerIdentityWhere(parsed);
    const vehicleIdentity = vehicleIdentityWhere(parsed);
    const customerWhere: Prisma.CustomerWhereInput = {
      testDataRunId: null,
      // One flat OR: the customer's own fields, plus — for a plate/VIN query — the
      // customer reached through the vehicle.
      OR: [
        ...(identity ? (identity.OR as Prisma.CustomerWhereInput[]) : []),
        ...(vehicleIdentity ? [{ vehicles: { some: vehicleIdentity } }] : []),
      ],
    };

    const [customers, vehicles, visits, inspections] = await Promise.all([
      customerWhere.OR && (customerWhere.OR as unknown[]).length > 0
        ? this.prisma.customer.findMany({
            where: customerWhere,
            take: TAKE,
            orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
            select: CUSTOMER_HIT_SELECT,
          })
        : // The empty branch is typed from the SAME select as the query. A bare
          // `Promise.resolve([])` infers `never[]`, and whether the union with the
          // real result widens back to the row type or collapses to `never` turns
          // out to depend on the compiler — which is how this reached a deploy as
          // "Property 'id' does not exist on type 'never'" while building clean
          // here. Stating the type removes the question.
          Promise.resolve<CustomerHit[]>([]),
      this.prisma.vehicle.findMany({
        where: {
          customer: { testDataRunId: null },
          OR: [
            ...(vehicleIdentity ? (vehicleIdentity.OR as Prisma.VehicleWhereInput[]) : []),
            // A name/phone query also lists the matching owners' vehicles so the
            // grouped result offers "2020 Honda Grace — 1234 AB · Owner: …".
            ...(identity ? [{ customer: identity }] : []),
          ],
        },
        orderBy: [{ plateNumber: 'asc' }],
        take: TAKE,
        select: {
          id: true, plateNumber: true, vehicleCode: true, make: true, model: true, modelYear: true,
          customer: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.serviceVisit.findMany({
        where: {
          testDataRunId: null,
          OR: [
            { visitNumber: { contains: visitNumberQuery, mode: 'insensitive' } },
            { queueTicket: { ticketNumber: { contains: visitNumberQuery, mode: 'insensitive' } } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
        select: {
          id: true, visitNumber: true, status: true, checkedInAt: true, arrivalAt: true, createdAt: true,
          customer: { select: { firstName: true, lastName: true } },
          vehicle: { select: { plateNumber: true, make: true, model: true } },
        },
      }),
      this.prisma.vehicleInspection.findMany({
        where: { inspectionNumber: { contains: q, mode: 'insensitive' } },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
        select: {
          id: true, inspectionNumber: true, kind: true, status: true, createdAt: true,
          serviceVisit: { select: { id: true, visitNumber: true } },
        },
      }),
    ]);

    // CR-2026-106 — a customer matched by name AND by phone (or via a vehicle) is
    // one row, not two; Prisma returns each row once, and a vehicle whose owner is
    // already listed is kept (it is the selectable "which car" result), but the
    // owner is never repeated.
    const seenCustomer = new Set<string>();
    const uniqueCustomers = customers.filter((c) => (seenCustomer.has(c.id) ? false : (seenCustomer.add(c.id), true)));

    return {
      query: q,
      customers: uniqueCustomers.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        customerNumber: c.customerNumber,
        phone: c.phone,
        email: c.email,
      })),
      vehicles: vehicles.map((v) => ({
        id: v.id,
        label: [v.modelYear, v.make, v.model].filter(Boolean).join(' ') || v.plateNumber,
        plateNumber: v.plateNumber,
        vehicleCode: v.vehicleCode,
        owner: v.customer ? { id: v.customer.id, name: `${v.customer.firstName} ${v.customer.lastName}` } : null,
      })),
      visits: visits.map((v) => ({
        id: v.id,
        visitNumber: v.visitNumber,
        status: v.status,
        visitedAt: v.checkedInAt ?? v.arrivalAt ?? v.createdAt,
        customer: `${v.customer.firstName} ${v.customer.lastName}`,
        vehicle: [v.vehicle.make, v.vehicle.model].filter(Boolean).join(' ') + ` · ${v.vehicle.plateNumber}`,
      })),
      inspections: inspections.map((i) => ({
        id: i.id,
        inspectionNumber: i.inspectionNumber,
        kind: i.kind,
        status: i.status,
        createdAt: i.createdAt,
        serviceVisitId: i.serviceVisit.id,
        visitNumber: i.serviceVisit.visitNumber,
      })),
    };
  }
}
