import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PLACEHOLDER_CUSTOMER_NUMBER } from '../../common/helpers/operational-scope';

/**
 * CR-2026-099 — reconciliation of historical unknown-customer visits.
 *
 * 1,089 imported visits sit on the "Historical — Unknown Customer" placeholder.
 * Their notes retain the ORIGINAL SharePoint job text (e.g. "SC3250FH: TUNDRA:
 * SERVICE:"), which usually carries the vehicle code/plate. This service
 * extracts those hints, proposes HIGH-CONFIDENCE candidates (exact vehicle-code
 * or plate match against real vehicles), and lets an administrator relink each
 * visit deliberately. Nothing is guessed automatically, nothing is deleted, and
 * ambiguous records stay explicitly AMBIGUOUS.
 */

const REVIEW_STATUSES = ['UNRESOLVED', 'RESOLVED', 'AMBIGUOUS'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Strip the import tag + HTML, decode the common entities the blobs use. */
export function extractHistoricalText(notes: string | null): string {
  if (!notes) return '';
  return notes
    .replace(/^\[hist[^\]]*\]\s*/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#58;/g, ':')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plate/vehicle-code-looking tokens from the job text (e.g. SC3250FH, 3250FH). */
export function extractVehicleTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/\b(SC)?([0-9]{3,4}[A-Z]{1,3})\b/g)) {
    tokens.add(m[2]); // plate form
    tokens.add(`SC${m[2]}`); // vehicle-code form
  }
  return [...tokens];
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async summary() {
    const grouped = await this.prisma.serviceVisit.groupBy({
      by: ['historicalReviewStatus'],
      where: { historicalReviewStatus: { not: null } },
      _count: true,
    });
    const counts: Record<string, number> = { UNRESOLVED: 0, RESOLVED: 0, AMBIGUOUS: 0 };
    for (const g of grouped) counts[g.historicalReviewStatus as string] = g._count;
    return { ...counts, total: counts.UNRESOLVED + counts.RESOLVED + counts.AMBIGUOUS };
  }

  async listUnresolved(take = 25, skip = 0, status: ReviewStatus = 'UNRESOLVED') {
    if (!REVIEW_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of ${REVIEW_STATUSES.join(', ')}`);
    }
    const [rows, total] = await Promise.all([
      this.prisma.serviceVisit.findMany({
        where: { historicalReviewStatus: status },
        orderBy: { checkedInAt: 'desc' },
        take: Math.min(take, 100),
        skip,
        select: {
          id: true, visitNumber: true, notes: true, checkedInAt: true, createdAt: true,
          vehicle: { select: { id: true, vehicleCode: true, plateNumber: true } },
        },
      }),
      this.prisma.serviceVisit.count({ where: { historicalReviewStatus: status } }),
    ]);

    // Candidate matching: exact vehicle-code/plate hits against REAL vehicles.
    const items = [];
    for (const v of rows) {
      const text = extractHistoricalText(v.notes);
      const tokens = extractVehicleTokens(text);
      const candidates = tokens.length
        ? await this.prisma.vehicle.findMany({
            where: {
              OR: [
                { vehicleCode: { in: tokens, mode: 'insensitive' } },
                { plateNumber: { in: tokens, mode: 'insensitive' } },
              ],
              customer: { customerNumber: { not: PLACEHOLDER_CUSTOMER_NUMBER } },
            },
            take: 5,
            select: {
              id: true, vehicleCode: true, plateNumber: true, make: true, model: true, modelYear: true,
              customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
            },
          })
        : [];
      items.push({
        visitId: v.id,
        visitNumber: v.visitNumber,
        visitedAt: v.checkedInAt ?? v.createdAt,
        sourceText: text.slice(0, 200),
        placeholderVehicleCode: v.vehicle.vehicleCode,
        candidates: candidates.map((c) => ({
          vehicleId: c.id,
          vehicleCode: c.vehicleCode,
          plateNumber: c.plateNumber,
          label: [c.modelYear, c.make, c.model].filter(Boolean).join(' ') || c.plateNumber,
          customer: { id: c.customer!.id, name: `${c.customer!.firstName} ${c.customer!.lastName}`, phone: c.customer!.phone },
        })),
      });
    }

    return { items, total, take, skip };
  }

  /** Relink one historical visit to a REAL vehicle (customer derived from it). */
  async relink(visitId: string, vehicleId: string, actorUserId: string) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: visitId },
      select: { id: true, historicalReviewStatus: true, customerId: true, vehicleId: true, notes: true },
    });
    if (!visit || visit.historicalReviewStatus == null) {
      throw new NotFoundException('Not a historical review record');
    }
    if (visit.historicalReviewStatus === 'RESOLVED') {
      throw new BadRequestException('Already resolved');
    }

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, customerId: true, plateNumber: true, customer: { select: { customerNumber: true, firstName: true, lastName: true } } },
    });
    if (!vehicle || !vehicle.customerId) throw new NotFoundException('Vehicle not found');
    if (vehicle.customer?.customerNumber === PLACEHOLDER_CUSTOMER_NUMBER) {
      throw new BadRequestException('Cannot relink to the placeholder customer');
    }

    await this.prisma.serviceVisit.update({
      where: { id: visitId },
      data: {
        customerId: vehicle.customerId,
        vehicleId: vehicle.id,
        historicalReviewStatus: 'RESOLVED',
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'HISTORICAL_VISIT_RELINKED',
      entityType: 'ServiceVisit',
      entityId: visitId,
      beforeJson: { customerId: visit.customerId, vehicleId: visit.vehicleId },
      afterJson: {
        customerId: vehicle.customerId,
        vehicleId: vehicle.id,
        plate: vehicle.plateNumber,
        customer: `${vehicle.customer?.firstName} ${vehicle.customer?.lastName}`,
      },
      notes: 'Manual reconciliation of historical unknown-customer visit',
    });

    return { relinked: true, customerId: vehicle.customerId, vehicleId: vehicle.id };
  }

  /** Mark a record reviewed-but-unlinkable. Stays queryable; never guessed. */
  async markAmbiguous(visitId: string, note: string | undefined, actorUserId: string) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: visitId },
      select: { id: true, historicalReviewStatus: true },
    });
    if (!visit || visit.historicalReviewStatus == null) {
      throw new NotFoundException('Not a historical review record');
    }
    await this.prisma.serviceVisit.update({
      where: { id: visitId },
      data: { historicalReviewStatus: 'AMBIGUOUS' },
    });
    await this.audit.log({
      actorUserId,
      action: 'HISTORICAL_VISIT_AMBIGUOUS',
      entityType: 'ServiceVisit',
      entityId: visitId,
      notes: note?.trim() || 'Reviewed — no confident match',
    });
    return { marked: true };
  }
}
