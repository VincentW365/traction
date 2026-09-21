import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EtaService } from '../scheduling/eta/eta.service';
import { ETA_PRESENTATION_DEFAULTS } from '../scheduling/eta/eta.config';
import { presentEta } from '../../common/helpers/eta-presentation';

/**
 * CR-2026-097 — the Visit is the authoritative operational record.
 *
 * This service serves the Visit Record screen: one aggregate carrying everything
 * that happened during a customer's service-centre visit (job sheet, inspections,
 * services, assignments, queue identity, timestamps), a chronological activity
 * timeline merged from the EXISTING audit/event infrastructure (StatusHistory,
 * QueueEvent, AuditLog, NotificationLog, lifecycle timestamps — no new history
 * mechanism), and a consolidated files view that preserves each file's source.
 */

export interface TimelineEvent {
  at: Date;
  type: string;
  label: string;
  actor?: string | null;
  detail?: string | null;
}

/**
 * The assignment fields the visit timeline reads, declared once so the query
 * and its empty-result branch cannot describe different rows.
 */
const TIMELINE_ASSIGNMENT_SELECT = {
  assignedAt: true,
  endedAt: true,
  isPrimary: true,
  technician: { select: { userAccount: { select: { fullName: true } } } },
  resource: { select: { name: true, code: true } },
  bay: { select: { code: true } },
} satisfies Prisma.TechnicianAssignmentSelect;

type TimelineAssignment = Prisma.TechnicianAssignmentGetPayload<{ select: typeof TIMELINE_ASSIGNMENT_SELECT }>;

@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    // CR-2026-105b — optional so the existing spec's `new VisitsService(prisma)` still works.
    @Optional() private readonly eta?: EtaService,
  ) {}

  // -------------------------------------------------------------------------
  // Visit Record aggregate
  // -------------------------------------------------------------------------

  async getRecord(id: string) {
    const v = await this.prisma.serviceVisit.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, customerNumber: true, firstName: true, lastName: true, phone: true, email: true },
        },
        vehicle: {
          select: { id: true, vehicleCode: true, plateNumber: true, make: true, model: true, modelYear: true, odometer: true },
        },
        site: { select: { id: true, name: true, code: true } },
        queueTicket: {
          select: {
            id: true, ticketNumber: true, ticketReference: true, displayTicketNumber: true,
            displayStatus: true, queueRank: true, generatedAt: true, lastRankedAt: true,
          },
        },
        appointment: {
          select: {
            id: true, scheduledStartAt: true, scheduledEndAt: true, status: true,
            services: { select: { serviceType: { select: { code: true, name: true } } } },
          },
        },
        serviceOrders: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, status: true, createdAt: true, startedAt: true, completedAt: true,
            promisedCompletionAt: true,
            advisorUserId: true,
            items: {
              select: {
                id: true, status: true,
                serviceType: { select: { code: true, name: true } },
              },
            },
            assignments: {
              orderBy: { assignedAt: 'asc' },
              select: {
                id: true, isPrimary: true, status: true, assignedAt: true, startedAt: true, endedAt: true,
                technician: {
                  select: { id: true, employeeCode: true, userAccount: { select: { fullName: true } } },
                },
                resource: { select: { id: true, code: true, name: true } },
                bay: { select: { id: true, code: true } },
              },
            },
          },
        },
        inspections: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, inspectionNumber: true, kind: true, status: true,
            createdAt: true, completedAt: true, signedOffAt: true, closedAt: true,
            skippedAt: true, skipReason: true, cancelledAt: true,
            performedByUserId: true,
            _count: { select: { items: true, photos: true, recommendations: true } },
          },
        },
        maintenanceRecommendations: {
          where: { supersedesRecommendationId: null },
          select: { id: true, serviceTypeCode: true, nextDueDate: true, nextDueOdometer: true, isDeterminable: true },
        },
        jobSheetDraft: {
          select: {
            id: true, createdAt: true, updatedAt: true, signatureImage: true, updatedByUserId: true,
          },
        },
      },
    });
    if (!v) throw new NotFoundException('Visit not found');

    // User names — inspections and job sheets store user ids as scalars.
    const userIds = [
      ...new Set(
        [...v.inspections.map((i) => i.performedByUserId), v.jobSheetDraft?.updatedByUserId].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.userAccount.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })
      : [];
    const inspectorName = new Map(users.map((u) => [u.id, u.fullName]));

    const workStartedAt =
      v.serviceOrders.map((o) => o.startedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const completedAt =
      v.serviceOrders.map((o) => o.completedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    const requestedServices = (v.appointment?.services ?? []).map((s) => s.serviceType);
    const orderServices = v.serviceOrders.flatMap((o) => o.items.map((i) => ({ ...i.serviceType, itemStatus: i.status })));

    // CR-2026-105b — Scheduled start · Actual start · Estimated completion · Actual
    // completion, from the one persisted estimate.
    let etaCfg = ETA_PRESENTATION_DEFAULTS;
    if (this.eta) {
      try {
        etaCfg = await this.eta.loadRules(v.siteId);
      } catch {
        etaCfg = ETA_PRESENTATION_DEFAULTS;
      }
    }
    const eta = presentEta({
      now: new Date(),
      visitStatus: v.status,
      queueRank: v.queueTicket?.queueRank ?? null,
      orderStatuses: v.serviceOrders.map((o) => o.status),
      promisedCompletionAt: v.serviceOrders.find((o) => o.promisedCompletionAt)?.promisedCompletionAt ?? null,
      scheduledStartAt: v.appointment?.scheduledStartAt ?? null,
      currentEtaStartAt: v.currentEtaStartAt,
      currentEtaCompleteAt: v.currentEtaCompleteAt,
      lastUpdatedAt: v.queueTicket?.lastRankedAt ?? null,
      config: etaCfg,
    });

    const { jobSheetDraft, inspections, ...visit } = v;

    return {
      ...visit,
      inspections: inspections.map(({ performedByUserId, ...i }) => ({
        ...i,
        inspector: performedByUserId ? (inspectorName.get(performedByUserId) ?? null) : null,
      })),
      // Human identity with graceful fallback for anything pre-backfill.
      visitNumber: v.visitNumber ?? v.queueTicket?.ticketReference ?? v.queueTicket?.ticketNumber ?? null,
      derived: {
        arrivalAt: v.arrivalAt,
        checkedInAt: v.checkedInAt,
        scheduledStartAt: v.appointment?.scheduledStartAt ?? null,
        workStartedAt,
        completedAt,
        durationMinutes:
          workStartedAt && completedAt
            ? Math.round((completedAt.getTime() - workStartedAt.getTime()) / 60000)
            : null,
        eta,
        requestedServices,
        orderServices,
      },
      jobSheet: jobSheetDraft
        ? {
            id: jobSheetDraft.id,
            // The job sheet is 1:1 with its visit — its number derives from the
            // visit identity rather than a second competing sequence.
            jobSheetNumber: v.visitNumber ? `JS-${v.visitNumber}` : null,
            createdAt: jobSheetDraft.createdAt,
            updatedAt: jobSheetDraft.updatedAt,
            hasSignature: !!jobSheetDraft.signatureImage,
            updatedBy: jobSheetDraft.updatedByUserId
              ? (inspectorName.get(jobSheetDraft.updatedByUserId) ?? null)
              : null,
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Activity timeline — merged from existing history infrastructure
  // -------------------------------------------------------------------------

  async getTimeline(id: string): Promise<TimelineEvent[]> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id },
      select: {
        id: true, createdAt: true, arrivalAt: true, checkedInAt: true, status: true, sourceType: true,
        queueTicket: { select: { id: true, ticketNumber: true, generatedAt: true } },
        serviceOrders: { select: { id: true } },
        inspections: {
          select: {
            id: true, inspectionNumber: true, kind: true, createdAt: true, completedAt: true,
            signedOffAt: true, skippedAt: true, skipReason: true, cancelledAt: true, cancelReason: true,
            performedByUserId: true,
          },
        },
        jobSheetDraft: { select: { createdAt: true, updatedAt: true, updatedByUserId: true } },
      },
    });
    if (!visit) throw new NotFoundException('Visit not found');

    const orderIds = visit.serviceOrders.map((o) => o.id);
    const inspectionIds = visit.inspections.map((i) => i.id);
    const performerIds = [
      ...new Set(
        [...visit.inspections.map((i) => i.performedByUserId), visit.jobSheetDraft?.updatedByUserId].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    const performers = performerIds.length
      ? await this.prisma.userAccount.findMany({ where: { id: { in: performerIds } }, select: { id: true, fullName: true } })
      : [];
    const performerName = new Map(performers.map((u) => [u.id, u.fullName]));

    const [statusHistory, queueEvents, auditRows, notifications, assignments] = await Promise.all([
      this.prisma.statusHistory.findMany({
        where: {
          OR: [
            { entityType: 'ServiceVisit', entityId: id },
            ...(orderIds.length ? [{ entityType: 'ServiceOrder', entityId: { in: orderIds } }] : []),
          ],
        },
        include: { changedBy: { select: { fullName: true } } },
        orderBy: { changedAt: 'asc' },
        take: 200,
      }),
      this.prisma.queueEvent.findMany({
        where: { serviceVisitId: id },
        include: { actor: { select: { fullName: true } } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      this.prisma.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'ServiceVisit', entityId: id },
            ...(inspectionIds.length ? [{ entityType: 'VehicleInspection', entityId: { in: inspectionIds } }] : []),
          ],
        },
        include: { actor: { select: { fullName: true } } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      this.prisma.notificationLog.findMany({
        where: { entityType: 'ServiceVisit', entityId: id },
        select: {
          createdAt: true, sentAt: true, channel: true, reason: true, templateKey: true, status: true,
          initiatedBy: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
      orderIds.length
        ? this.prisma.technicianAssignment.findMany({
            where: { serviceOrderId: { in: orderIds } },
            select: TIMELINE_ASSIGNMENT_SELECT,
            orderBy: { assignedAt: 'asc' },
            take: 100,
          })
        : // Typed for the same reason as the customer search (see there): an
          // untyped empty array infers `never[]`, which some compilers keep.
          Promise.resolve<TimelineAssignment[]>([]),
    ]);

    // CR-2026-098 — pause/waiting intervals with their measured durations. This is
    // where "how long did that car sit waiting on parts" survives historically.
    const pauseRows = orderIds.length
      ? await this.prisma.serviceOrderPause.findMany({
          where: { serviceOrderId: { in: orderIds } },
          orderBy: { startedAt: 'asc' },
          take: 100,
        })
      : [];

    const events: TimelineEvent[] = [];
    const push = (at: Date | null | undefined, type: string, label: string, actor?: string | null, detail?: string | null) => {
      if (at) events.push({ at, type, label, actor: actor ?? null, detail: detail ?? null });
    };

    // Visit lifecycle
    push(visit.createdAt, 'VISIT_CREATED', visit.sourceType === 'WALKIN' ? 'Walk-in registered' : 'Visit created');
    if (visit.checkedInAt && visit.checkedInAt.getTime() !== visit.createdAt.getTime()) {
      push(visit.checkedInAt, 'CHECKED_IN', 'Customer checked in');
    }
    push(visit.queueTicket?.generatedAt, 'TICKET_CREATED', `Queue ticket ${visit.queueTicket?.ticketNumber ?? ''} created`.trim());

    // Status transitions (visit + orders)
    for (const s of statusHistory) {
      push(
        s.changedAt,
        `STATUS_${s.entityType.toUpperCase()}`,
        `${s.entityType === 'ServiceVisit' ? 'Visit' : 'Work order'} status: ${s.fromStatus ? `${s.fromStatus} → ` : ''}${s.toStatus}`,
        s.changedBy?.fullName,
        s.notes ?? s.reasonCode,
      );
    }

    // Queue events (skip pure re-rank noise)
    for (const e of queueEvents) {
      if (e.eventType === 'RANK_CHANGED') continue;
      push(e.createdAt, `QUEUE_${e.eventType}`, `Queue: ${e.eventType.replace(/_/g, ' ').toLowerCase()}`, e.actor?.fullName, e.reasonCode);
    }

    // Technician / bay assignments
    for (const a of assignments) {
      const tech = a.technician.userAccount.fullName;
      const where = a.resource?.name ?? a.resource?.code ?? a.bay?.code;
      push(a.assignedAt, 'TECH_ASSIGNED', `Technician assigned: ${tech}${where ? ` (${where})` : ''}${a.isPrimary ? '' : ' (assist)'}`);
      push(a.endedAt, 'TECH_ENDED', `Assignment ended: ${tech}`);
    }

    // Pause / waiting intervals (reason + measured duration)
    const PAUSE_LABELS: Record<string, string> = {
      WAITING_PARTS: 'Waiting for parts',
      WAITING_TECH: 'Waiting for technician assistance',
      WAITING_BAY: 'Waiting for bay / equipment',
      CUSTOMER_AUTHORIZATION: 'Waiting for authorization',
      FURTHER_DIAGNOSIS: 'Needs further diagnosis',
      EXTERNAL_MACHINE_SHOP: 'At external machine shop',
      BREAK_OR_END_OF_DAY: 'Break / end of day',
      OTHER: 'Paused — other',
    };
    for (const p of pauseRows) {
      const label = PAUSE_LABELS[p.reasonCode] ?? p.reasonCode;
      push(p.startedAt, `PAUSE_${p.reasonCode}`, `Work stopped: ${label}`, null, p.notes);
      if (p.endedAt) {
        const min = Math.round((p.endedAt.getTime() - p.startedAt.getTime()) / 60000);
        push(p.endedAt, 'PAUSE_ENDED', `Work resumed after ${min} min (${label.toLowerCase()})`);
      }
    }

    // Inspections
    for (const i of visit.inspections) {
      const kindLabel = i.kind === 'PRE_INSPECTION' ? 'Pre-inspection' : 'Vehicle inspection';
      const who = i.performedByUserId ? (performerName.get(i.performedByUserId) ?? null) : null;
      push(i.createdAt, 'INSPECTION_STARTED', `${kindLabel} ${i.inspectionNumber} started`, who);
      push(i.completedAt, 'INSPECTION_COMPLETED', `${kindLabel} ${i.inspectionNumber} completed`, who);
      push(i.signedOffAt, 'INSPECTION_SIGNED_OFF', `${kindLabel} ${i.inspectionNumber} signed off`);
      push(i.skippedAt, 'INSPECTION_SKIPPED', `${kindLabel} ${i.inspectionNumber} skipped`, null, i.skipReason);
      push(i.cancelledAt, 'INSPECTION_CANCELLED', `${kindLabel} ${i.inspectionNumber} cancelled`, null, i.cancelReason);
    }

    // Job sheet
    if (visit.jobSheetDraft) {
      const sheetActor = visit.jobSheetDraft.updatedByUserId
        ? (performerName.get(visit.jobSheetDraft.updatedByUserId) ?? null)
        : null;
      push(visit.jobSheetDraft.createdAt, 'JOB_SHEET_CREATED', 'Job sheet started', sheetActor);
      if (visit.jobSheetDraft.updatedAt.getTime() - visit.jobSheetDraft.createdAt.getTime() > 60_000) {
        push(visit.jobSheetDraft.updatedAt, 'JOB_SHEET_SAVED', 'Job sheet saved', sheetActor);
      }
    }

    // Customer notifications
    for (const n of notifications) {
      const what = n.reason ? n.reason.replace(/_/g, ' ').toLowerCase() : n.templateKey.replace(/_/g, ' ');
      push(n.sentAt ?? n.createdAt, 'NOTIFICATION', `Customer notified (${n.channel}): ${what}`, n.initiatedBy?.fullName, n.status);
    }

    // Audit rows not already represented (manual overrides etc.). Inspection
    // create/cancel/skip audits duplicate the lifecycle timestamps pushed above.
    const covered = new Set(['JOB_SHEET_SAVED', 'INSPECTION_CREATE', 'INSPECTION_CANCEL', 'INSPECTION_SKIP']);
    for (const a of auditRows) {
      if (covered.has(a.action)) continue;
      push(a.createdAt, `AUDIT_${a.action}`, a.action.replace(/_/g, ' ').toLowerCase(), a.actor?.fullName, a.notes ?? a.reasonCode);
    }

    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    return events.slice(0, 300);
  }

  // -------------------------------------------------------------------------
  // Consolidated files — grouped by originating record
  // -------------------------------------------------------------------------

  async getFiles(id: string) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id },
      select: {
        id: true,
        inspections: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, inspectionNumber: true, kind: true, status: true,
            photos: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, caption: true, category: true, mimeType: true, byteSize: true, createdAt: true },
            },
          },
        },
        jobSheetDraft: { select: { id: true, signatureImage: true, updatedAt: true } },
      },
    });
    if (!visit) throw new NotFoundException('Visit not found');

    return {
      groups: [
        ...visit.inspections
          .filter((i) => i.photos.length > 0)
          .map((i) => ({
            source: i.kind,
            sourceLabel: i.kind === 'PRE_INSPECTION' ? 'Pre-Inspection' : 'Vehicle Inspection',
            inspectionId: i.id,
            inspectionNumber: i.inspectionNumber,
            photos: i.photos,
          })),
        ...(visit.jobSheetDraft?.signatureImage
          ? [{
              source: 'JOB_SHEET' as const,
              sourceLabel: 'Job Sheet',
              jobSheetId: visit.jobSheetDraft.id,
              hasSignature: true,
              updatedAt: visit.jobSheetDraft.updatedAt,
            }]
          : []),
      ],
    };
  }

  /** Resolve a human visit number (or ticket number) to the visit id. */
  async resolveByNumber(visitNumber: string) {
    const v = await this.prisma.serviceVisit.findFirst({
      where: {
        OR: [
          { visitNumber: { equals: visitNumber, mode: 'insensitive' } },
          { queueTicket: { ticketNumber: { equals: visitNumber, mode: 'insensitive' } } },
        ],
      },
      select: { id: true, visitNumber: true },
    });
    if (!v) throw new NotFoundException(`No visit found for "${visitNumber}"`);
    return v;
  }
}
