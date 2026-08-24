import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

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

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(rawQuery: string): Promise<SearchResults> {
    const q = (rawQuery ?? '').trim();
    const empty: SearchResults = { query: q, customers: [], vehicles: [], visits: [], inspections: [] };
    if (q.length < 2) return empty;

    const digits = q.replace(/\D/g, '');
    // "JS-B01-260820-003" is the job sheet OF visit B01-260820-003.
    const jobSheetMatch = /^js-?(.+)$/i.exec(q);
    const visitNumberQuery = jobSheetMatch ? jobSheetMatch[1] : q;

    const nameParts = q.split(/\s+/).filter(Boolean);
    const customerWhere: Prisma.CustomerWhereInput = {
      testDataRunId: null,
      OR: [
        { customerNumber: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits.slice(-7) } }] : []),
        ...(nameParts.length >= 2
          ? [{
              AND: [
                { firstName: { contains: nameParts[0], mode: 'insensitive' as const } },
                { lastName: { contains: nameParts.slice(1).join(' '), mode: 'insensitive' as const } },
              ],
            }]
          : [
              { firstName: { contains: q, mode: 'insensitive' as const } },
              { lastName: { contains: q, mode: 'insensitive' as const } },
            ]),
      ],
    };

    const [customers, vehicles, visits, inspections] = await Promise.all([
      this.prisma.customer.findMany({
        where: customerWhere,
        take: TAKE,
        select: { id: true, customerNumber: true, firstName: true, lastName: true, phone: true, email: true },
      }),
      this.prisma.vehicle.findMany({
        where: {
          customer: { testDataRunId: null },
          OR: [
            { plateNumber: { contains: q, mode: 'insensitive' } },
            { vin: { contains: q, mode: 'insensitive' } },
            { vehicleCode: { contains: q, mode: 'insensitive' } },
          ],
        },
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

    return {
      query: q,
      customers: customers.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`,
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
