import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { differenceInMinutes } from 'date-fns';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { liveVisitSql } from '../../common/helpers/operational-scope';
import {
  describeVisitServices,
  VISIT_SERVICES_INCLUDE,
} from '../../common/helpers/service-description';

/**
 * CR-2026-018 (P3) — a ServiceVisit may be marked ABANDONED (no-show / left
 * before service) only from a pre-completion, non-terminal status. QC,
 * READY_FOR_PICKUP, CLOSED, CANCELLED and ABANDONED are excluded (service is
 * effectively done or already terminal).
 */
const ABANDONABLE_VISIT_STATUSES = [
  'CREATED',
  'ARRIVED',
  'CHECKED_IN',
  'QUEUED',
  'CALLED',
  'IN_SERVICE',
  'WAITING_PARTS',
];

/** Source of the ETA average — CR-2026-007 (explainability/audit). */
export type EtaBasis = 'LIVE' | 'HISTORICAL_FALLBACK' | 'DEFAULT';
interface AvgServiceResult {
  minutes: number;
  basis: EtaBasis;
  sampleSize: number;
}

/** ETA average defaults (CR-2026-007) — overridable via BusinessRuleConfig. */
const ETA_DEFAULT_MINUTES = 30;
const ETA_DEFAULT_WINDOW_DAYS = 30;
const ETA_DEFAULT_MIN_LIVE_SAMPLE = 20;
// CR-2026-015 — outlier trimming. 0 = disabled (no trimming; default behavior).
const ETA_DEFAULT_OUTLIER_CAP_MINUTES = 0;

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private schedulingService: SchedulingService,
    private statusHistory: StatusHistoryService,
  ) {}

  // ---------------------------------------------------------------------------
  // BOARD — FIFO ordered
  // ---------------------------------------------------------------------------

  async getBoard(siteId: string) {
    const now = new Date();

    const tickets = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: {
          siteId,
          // CR-2026-084 — 'QC' included. A car sent for a quality check dropped off
          // the board completely: it was no longer waiting, no longer in service,
          // and not yet ready for pickup, so for the whole QC window nobody could
          // see it anywhere on the queue. READY_FOR_PICKUP is deliberately left out
          // — those cars surface in the dedicated pickup panel above the board.
          status: { in: ['CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE', 'QC'] },
        },
        displayStatus: {
          in: ['PENDING_RANK', 'WAITING', 'CALLED', 'IN_SERVICE', 'BLOCKED'],
        },
      },
      include: {
        serviceVisit: {
          // CR-2026-084 — service orders too, so a walk-in's services resolve.
          include: VISIT_SERVICES_INCLUDE,
        },
      },
      orderBy: [{ queueRank: { sort: 'asc', nulls: 'last' } }],
    });

    const eta = await this.getAvgServiceMinutes(siteId);
    const avgServiceMinutes = eta.minutes;

    const items = tickets.map((t) => {
      const sv = t.serviceVisit;
      const serviceDescription = describeVisitServices(sv);

      return {
        queueTicketId: t.id,
        ticketNumber: t.ticketNumber,
        fifoPosition: t.queueRank,
        displayStatus: t.displayStatus,
        // CR-2026-084 — QueueDisplayStatus cannot express QC or "ready for pickup",
        // so the board also carries the visit's own status. Without it the board
        // could never distinguish a car being worked on from one awaiting collection.
        visitStatus: sv.status,
        sourceType: sv.sourceType,
        blockedReason: t.blockedReason ?? (t.displayStatus === 'BLOCKED' ? this.getBlockedReason(sv) : null),
        readyForDispatch: t.readyForDispatch,
        partsReadiness: sv.partsReadiness,
        estimatedWaitMinutes:
          t.queueRank != null ? t.queueRank * avgServiceMinutes : null,
        serviceDescription,
        timeWaitingMinutes: sv.checkedInAt
          ? differenceInMinutes(now, sv.checkedInAt)
          : 0,
        overrideActive: t.overrideActive,
        overrideReasonCode: t.overrideReasonCode,
      };
    });

    // CR-2026-007: surface the ETA basis on the STAFF board only (additive,
    // backward compatible). Never added to the public display board.
    return {
      siteId,
      generatedAt: now,
      items,
      etaBasis: eta.basis,
      etaSampleSize: eta.sampleSize,
    };
  }

  // ---------------------------------------------------------------------------
  // TICKET DETAIL with event history
  // ---------------------------------------------------------------------------

  async getTicketDetail(ticketId: string) {
    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: ticketId },
      include: {
        serviceVisit: {
          include: {
            customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
            vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
            // CR-2026-084 — service orders too, so a walk-in's services resolve
            // instead of the page falling back to the literal "Walk-in service".
            ...VISIT_SERVICES_INCLUDE,
          },
        },
        queueEvents: { orderBy: { createdAt: 'desc' }, take: 30 },
      },
    });

    if (!ticket) throw new NotFoundException(`Queue ticket ${ticketId} not found`);
    // Resolved server-side so every client shows the same answer.
    return {
      ...ticket,
      serviceDescription: describeVisitServices(ticket.serviceVisit, ', '),
    };
  }

  // ---------------------------------------------------------------------------
  // OVERRIDE — PIN_TO_POSITION only (v2 simplified)
  // ---------------------------------------------------------------------------

  async applyOverride(
    ticketId: string,
    input: { reasonCode: string; targetPosition: number; expiresAt?: string; notes?: string },
    userId: string,
  ) {
    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: ticketId },
      include: { serviceVisit: true },
    });

    if (!ticket) throw new NotFoundException(`Queue ticket ${ticketId} not found`);
    if (['COMPLETED', 'CANCELLED'].includes(ticket.displayStatus)) {
      throw new BadRequestException(`Cannot override ticket in status ${ticket.displayStatus}`);
    }
    if (input.targetPosition < 1) {
      throw new BadRequestException('targetPosition must be >= 1');
    }

    const positionBefore = ticket.queueRank;

    const updated = await this.prisma.queueTicket.update({
      where: { id: ticketId },
      data: {
        overrideActive: true,
        overrideReasonCode: input.reasonCode,
        overrideAppliedBy: userId,
        overrideAppliedAt: new Date(),
        overridePriorityMode: 'PIN_TO_POSITION',
        overrideRankPosition: input.targetPosition,
        overrideExpiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        overrideClearedAt: null,
        overrideClearedBy: null,
      },
    });

    await this.logEvent(ticket.serviceVisitId, ticketId, 'OVERRIDE_APPLIED', userId, {
      positionBefore,
      positionAfter: input.targetPosition,
      reasonCode: input.reasonCode,
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'QUEUE_OVERRIDE_APPLIED',
      entityType: 'QueueTicket',
      entityId: ticketId,
      beforeJson: { position: positionBefore, overrideActive: false },
      afterJson: { position: input.targetPosition, overrideActive: true, reasonCode: input.reasonCode },
      reasonCode: input.reasonCode,
      notes: input.notes,
    });

    await this.schedulingService.recomputeQueue(ticket.serviceVisit.siteId);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // CLEAR OVERRIDE
  // ---------------------------------------------------------------------------

  async clearOverride(ticketId: string, userId: string, reason?: string) {
    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: ticketId },
      include: { serviceVisit: true },
    });

    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);
    if (!ticket.overrideActive) throw new BadRequestException('No active override to clear');

    const updated = await this.prisma.queueTicket.update({
      where: { id: ticketId },
      data: {
        overrideActive: false,
        overrideClearedAt: new Date(),
        overrideClearedBy: userId,
      },
    });

    await this.logEvent(ticket.serviceVisitId, ticketId, 'OVERRIDE_CLEARED', userId, {
      positionBefore: ticket.queueRank,
      reasonCode: reason ?? 'manual_clear',
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'QUEUE_OVERRIDE_CLEARED',
      entityType: 'QueueTicket',
      entityId: ticketId,
      beforeJson: { overrideActive: true, reasonCode: ticket.overrideReasonCode },
      afterJson: { overrideActive: false },
      reasonCode: reason ?? 'manual_clear',
    });

    await this.schedulingService.recomputeQueue(ticket.serviceVisit.siteId);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // CALL NEXT — FIFO dispatch
  // ---------------------------------------------------------------------------

  async callNext(siteId: string, userId: string, preferResourceId?: string) {
    // 1. Load all WAITING tickets in FIFO order
    const waitingTickets = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: { siteId },
        displayStatus: 'WAITING',
        queueRank: { not: null },
        readyForDispatch: true,
      },
      orderBy: { queueRank: 'asc' },
      include: {
        serviceVisit: {
          include: {
            vehicle: { select: { weightClass: true, serviceClass: true } },
            appointment: {
              include: { services: { include: { serviceType: true } } },
            },
          },
        },
      },
    });

    if (waitingTickets.length === 0) {
      return { message: 'No eligible tickets in queue', called: null, assignedResourceId: null, assignedResourceCode: null };
    }

    // 2. Load available resources (not occupied)
    const resources = await this.prisma.workResource.findMany({
      where: { siteId, isActive: true },
      include: { occupancy: true },
      orderBy: { displayOrder: 'asc' },
    });

    const freeResources = resources.filter(
      (r) => !r.occupancy || r.occupancy.status === 'AVAILABLE',
    );

    if (freeResources.length === 0) {
      return { message: 'No resources available', called: null, assignedResourceId: null, assignedResourceCode: null };
    }

    // 3. If a specific resource is preferred, filter to just that one
    const candidateResources = preferResourceId
      ? freeResources.filter((r) => r.id === preferResourceId)
      : freeResources;

    // 4. For each ticket in FIFO order, find a compatible free resource
    for (const ticket of waitingTickets) {
      const sv = ticket.serviceVisit;
      const vehicleWeight = sv.vehicle?.weightClass ?? 'STANDARD';
      const serviceTypes = sv.appointment?.services?.map((s) => s.serviceType) ?? [];
      const requiresAlignment = serviceTypes.some((st) => st.requiredBayType === 'ALIGNMENT');
      const requiresDiagnostics = serviceTypes.some((st) => st.requiredBayType === 'DIAGNOSTIC');
      const canUseOverflow = serviceTypes.every((st) => st.canUseOverflow);
      const canUseLightSlot = serviceTypes.every((st) => st.canUseLightSlot);

      const vehicleServiceClass = sv.vehicle?.serviceClass ?? null;

      for (const resource of candidateResources) {
        // DMAIC Rule 3: mobile jacks are sedan-only — auto-dispatch never picks one
        // for a non-sedan/unknown-class vehicle (explicit assignment can override).
        if (resource.liftType === 'mobile' && vehicleServiceClass !== 'SEDAN_CLASS') continue;

        // Weight check
        const weightOrder = { LIGHT: 1, STANDARD: 2, HEAVY: 3 };
        const resCapacity = weightOrder[resource.maxVehicleWeight ?? 'HEAVY'];
        const vehWeight = weightOrder[vehicleWeight as keyof typeof weightOrder] ?? 2;
        if (vehWeight > resCapacity) continue;

        // Category check
        if (resource.resourceCategory === 'OVERFLOW' && !canUseOverflow) continue;
        if (resource.resourceCategory === 'LIGHT_SLOT' && !canUseLightSlot) continue;

        // Capability checks
        if (requiresAlignment && !resource.hasAlignment) continue;
        if (requiresDiagnostics && !resource.hasDiagnostics) continue;

        // Compatible! Dispatch this ticket to this resource.
        await this.prisma.$transaction(async (tx) => {
          await tx.queueTicket.update({
            where: { id: ticket.id },
            data: { displayStatus: 'CALLED' },
          });

          // Mark resource as occupied
          await tx.resourceOccupancy.upsert({
            where: { resourceId: resource.id },
            update: {
              serviceVisitId: sv.id,
              status: 'OCCUPIED',
              occupiedAt: new Date(),
            },
            create: {
              resourceId: resource.id,
              serviceVisitId: sv.id,
              status: 'OCCUPIED',
              occupiedAt: new Date(),
            },
          });
        });

        await this.logEvent(sv.id, ticket.id, 'CALLED', userId, {
          positionBefore: ticket.queueRank,
          reasonCode: `dispatched_to_${resource.code}`,
        });

        await this.schedulingService.recomputeQueue(siteId);

        return {
          message: `Ticket called to ${resource.name}`,
          called: ticket.ticketNumber,
          assignedResourceId: resource.id,
          assignedResourceCode: resource.code,
        };
      }
    }

    // No ticket could be matched to any available resource
    return {
      message: 'No compatible resource available for waiting tickets',
      called: null,
      assignedResourceId: null,
      assignedResourceCode: null,
    };
  }

  // ---------------------------------------------------------------------------
  // RECOMPUTE trigger
  // ---------------------------------------------------------------------------

  async triggerRecompute(siteId: string) {
    await this.schedulingService.recomputeQueue(siteId);
    return { message: 'Queue recomputed', siteId };
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // READY FOR PICKUP — visits awaiting customer pickup
  // ---------------------------------------------------------------------------

  async getReadyForPickup(siteId: string) {
    // CR-2026-006 exempt (already live): HISTORICAL_IMPORT visits are terminal
    // CLOSED, so the READY_FOR_PICKUP status filter already excludes them.
    const visits = await this.prisma.serviceVisit.findMany({
      where: {
        siteId,
        status: 'READY_FOR_PICKUP',
      },
      include: {
        customer: { select: { firstName: true, lastName: true, phone: true, email: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
        queueTicket: { select: { ticketNumber: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return visits.map((v) => ({
      serviceVisitId: v.id,
      ticketNumber: v.queueTicket?.ticketNumber ?? 'N/A',
      customerName: `${v.customer.firstName} ${v.customer.lastName}`,
      customerPhone: v.customer.phone,
      customerEmail: v.customer.email,
      vehiclePlate: v.vehicle.plateNumber,
      vehicleDescription: [v.vehicle.make, v.vehicle.model].filter(Boolean).join(' '),
    }));
  }

  // ---------------------------------------------------------------------------
  // COMPLETE TICKET — technician marks work done
  // ---------------------------------------------------------------------------

  async completeTicket(ticketId: string, userId: string) {
    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: ticketId },
      include: { serviceVisit: true },
    });

    if (!ticket) throw new NotFoundException(`Queue ticket ${ticketId} not found`);
    if (['COMPLETED', 'CANCELLED'].includes(ticket.displayStatus)) {
      throw new BadRequestException(`Ticket already in status ${ticket.displayStatus}`);
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Update ticket to COMPLETED
      await tx.queueTicket.update({
        where: { id: ticketId },
        data: { displayStatus: 'COMPLETED' },
      });

      // Update service visit to READY_FOR_PICKUP
      await tx.serviceVisit.update({
        where: { id: ticket.serviceVisitId },
        data: { status: 'READY_FOR_PICKUP' },
      });

      // Release any occupied resource for this visit
      await tx.resourceOccupancy.updateMany({
        where: { serviceVisitId: ticket.serviceVisitId, status: 'OCCUPIED' },
        data: { status: 'AVAILABLE', serviceVisitId: null, technicianId: null },
      });
    });

    await this.logEvent(ticket.serviceVisitId, ticketId, 'COMPLETED', userId, {
      positionBefore: ticket.queueRank,
      reasonCode: 'work_complete',
    });

    // Trigger recompute to update remaining positions
    await this.schedulingService.recomputeQueue(ticket.serviceVisit.siteId);

    this.logger.log(`Ticket ${ticket.ticketNumber} completed by user ${userId}`);

    return {
      message: 'Work marked as complete. Vehicle is ready for pickup.',
      ticketNumber: ticket.ticketNumber,
      serviceVisitId: ticket.serviceVisitId,
    };
  }

  /**
   * CR-2026-078 — final "Picked Up" close-out. One click after the pickup notification:
   * closes the visit, completes its ticket (clears the board), frees any bay, and
   * recomputes. Idempotent; deliberately lightweight (payment/mileage capture stays on
   * the full "Complete Visit" form for when it's needed).
   */
  async markPickedUp(serviceVisitId: string, userId: string) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: { queueTicket: true, serviceOrders: true },
    });
    if (!visit) throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    if (visit.status === 'CLOSED') {
      return { message: 'Visit already closed.', serviceVisitId };
    }

    // CR-2026-085 — the payment gate was removed at the owner's direction (payment
    // is settled in the external POS). Both close-out paths now behave the same:
    // neither blocks, and both leave an audit trail if payment was not cleared.
    const PAYMENT_CLEARED = ['PAID', 'ON_ACCOUNT', 'WAIVED'];
    const unpaidOrders = (visit.serviceOrders ?? []).filter(
      (so) => !PAYMENT_CLEARED.includes(so.paymentStatus),
    );
    if (unpaidOrders.length > 0) {
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.PAYMENT_RELEASE_OVERRIDE,
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        beforeJson: {
          unpaidOrders: unpaidOrders.map((o) => ({ id: o.id, paymentStatus: o.paymentStatus })),
        },
        afterJson: { released: true, gateEnforced: false },
        reasonCode: 'RELEASED_PAYMENT_NOT_CLEARED',
        notes: 'Vehicle marked picked up with payment not cleared (payment gate disabled).',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceVisit.update({
        where: { id: serviceVisitId },
        data: { status: 'CLOSED' },
      });
      if (visit.queueTicket && !['COMPLETED', 'CANCELLED'].includes(visit.queueTicket.displayStatus)) {
        await tx.queueTicket.update({
          where: { id: visit.queueTicket.id },
          data: { displayStatus: 'COMPLETED' },
        });
      }
      await tx.resourceOccupancy.updateMany({
        where: { serviceVisitId, status: 'OCCUPIED' },
        data: { status: 'AVAILABLE', serviceVisitId: null, technicianId: null },
      });
    });

    if (visit.queueTicket) {
      await this.logEvent(serviceVisitId, visit.queueTicket.id, 'PICKED_UP', userId, {
        reasonCode: 'picked_up',
      });
    }
    await this.schedulingService.recomputeQueue(visit.siteId);
    this.logger.log(`Visit ${serviceVisitId} marked picked up (closed) by ${userId}`);

    return { message: 'Vehicle picked up. Visit closed.', serviceVisitId };
  }

  // ---------------------------------------------------------------------------
  // ABANDON VISIT — no-show / left before service (CR-2026-018, P3)
  //
  // Terminal operational transition: the ServiceVisit becomes ABANDONED and its
  // QueueTicket is closed (displayStatus CANCELLED) so it drops out of the
  // active board/recompute and stops corrupting rank/ETA/KPIs. Nothing is
  // deleted. A reason is required; the transition is audited (StatusHistory +
  // AuditLog) and the queue is recomputed for the site. Historical-import
  // visits are never abandonable.
  // ---------------------------------------------------------------------------

  async abandonVisit(
    ticketId: string,
    input: { reasonCode: string; notes?: string },
    userId: string,
  ) {
    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: ticketId },
      include: { serviceVisit: true },
    });

    if (!ticket) throw new NotFoundException(`Queue ticket ${ticketId} not found`);

    const sv = ticket.serviceVisit;

    // Guard: ticket already in a terminal display state.
    if (['COMPLETED', 'CANCELLED'].includes(ticket.displayStatus)) {
      throw new BadRequestException(
        `Cannot abandon a ticket already in status ${ticket.displayStatus}`,
      );
    }
    // Guard: never treat imported historical visits as abandonable.
    if (sv.sourceType === 'HISTORICAL_IMPORT') {
      throw new BadRequestException('Historical-import visits cannot be abandoned');
    }
    // Guard: only active, pre-completion visit statuses may be abandoned.
    if (!ABANDONABLE_VISIT_STATUSES.includes(sv.status)) {
      throw new BadRequestException(
        `Cannot mark visit abandoned from status ${sv.status}`,
      );
    }

    const fromVisitStatus = sv.status;
    const fromDisplayStatus = ticket.displayStatus;

    await this.prisma.$transaction(async (tx) => {
      // Visit becomes terminal ABANDONED (canonical operational truth).
      await tx.serviceVisit.update({
        where: { id: sv.id },
        data: { status: 'ABANDONED' },
      });

      // Close the queue ticket so it leaves the active board/recompute. The
      // QueueDisplayStatus enum has no ABANDONED member; CANCELLED is the
      // terminal display state (no schema change).
      await tx.queueTicket.update({
        where: { id: ticketId },
        data: { displayStatus: 'CANCELLED' },
      });

      // Release any resource this visit was occupying.
      await tx.resourceOccupancy.updateMany({
        where: { serviceVisitId: sv.id, status: 'OCCUPIED' },
        data: { status: 'AVAILABLE', serviceVisitId: null, technicianId: null },
      });
    });

    await this.logEvent(sv.id, ticketId, 'ABANDONED', userId, {
      positionBefore: ticket.queueRank,
      reasonCode: input.reasonCode,
    });

    await this.statusHistory.record({
      entityType: 'ServiceVisit',
      entityId: sv.id,
      fromStatus: fromVisitStatus,
      toStatus: 'ABANDONED',
      changedByUserId: userId,
      reasonCode: input.reasonCode,
      notes: input.notes,
    });

    await this.auditService.log({
      actorUserId: userId,
      action: AUDIT_ACTIONS.SERVICE_VISIT_ABANDONED,
      entityType: 'ServiceVisit',
      entityId: sv.id,
      beforeJson: { status: fromVisitStatus, displayStatus: fromDisplayStatus },
      afterJson: { status: 'ABANDONED', displayStatus: 'CANCELLED' },
      reasonCode: input.reasonCode,
      notes: input.notes,
    });

    // Re-rank the remaining live tickets for this site.
    await this.schedulingService.recomputeQueue(sv.siteId);

    this.logger.log(
      `Visit ${sv.id} (ticket ${ticket.ticketNumber}) abandoned by ${userId}: ${input.reasonCode}`,
    );

    return {
      message: 'Visit marked as abandoned and removed from the active queue.',
      ticketNumber: ticket.ticketNumber,
      serviceVisitId: sv.id,
      status: 'ABANDONED',
    };
  }

  // ---------------------------------------------------------------------------
  // PUBLIC DISPLAY BOARD — sanitized, PII-free projection for the waiting-room
  // screen. NEVER include customer names, phones, emails, or full plates here:
  // this is rendered on a public screen visible to everyone in the lobby
  // (CLAUDE.md §10). Tickets are identified only by their (immutable) number.
  // ---------------------------------------------------------------------------

  async getPublicDisplayBoard(siteId: string) {
    const now = new Date();

    const [site, tickets, occupancies, readyVisits] =
      await Promise.all([
        this.prisma.site.findUnique({ where: { id: siteId }, select: { name: true, timezone: true } }),
        this.prisma.queueTicket.findMany({
          where: {
            serviceVisit: {
              siteId,
              // CR-2026-086 — 'QC' included. A car being quality-checked is not
              // waiting, not (by visit status) in service, and not yet ready, so it
              // vanished from the lobby screen entirely for the whole QC window and
              // the customer watching the board saw their ticket simply disappear.
              status: { in: ['CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE', 'QC'] },
            },
            displayStatus: {
              in: ['PENDING_RANK', 'WAITING', 'CALLED', 'IN_SERVICE', 'BLOCKED'],
            },
          },
          select: {
            ticketNumber: true,
            queueRank: true,
            displayStatus: true,
            serviceVisitId: true,
          },
          orderBy: [{ queueRank: { sort: 'asc', nulls: 'last' } }],
        }),
        this.prisma.resourceOccupancy.findMany({
          where: { status: 'OCCUPIED', serviceVisit: { siteId } },
          select: { serviceVisitId: true, resource: { select: { name: true } } },
        }),
        // CR-2026-006 exempt (already live): READY_FOR_PICKUP excludes terminal
        // historical visits.
        this.prisma.serviceVisit.findMany({
          where: { siteId, status: 'READY_FOR_PICKUP' },
          select: { queueTicket: { select: { ticketNumber: true } }, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        }),
      ]);

    // serviceVisitId -> bay/resource display name
    const bayByVisit = new Map<string, string>();
    for (const occ of occupancies) {
      if (occ.serviceVisitId && occ.resource?.name) {
        bayByVisit.set(occ.serviceVisitId, occ.resource.name);
      }
    }

    const inService = tickets
      .filter((t) => t.displayStatus === 'CALLED' || t.displayStatus === 'IN_SERVICE')
      .map((t) => ({
        ticketNumber: t.ticketNumber,
        bay: bayByVisit.get(t.serviceVisitId) ?? null,
      }));

    const inQueue = tickets
      .filter((t) =>
        ['WAITING', 'PENDING_RANK', 'BLOCKED'].includes(t.displayStatus),
      )
      .map((t) => ({
        ticketNumber: t.ticketNumber,
        position: t.queueRank,
      }));

    const ready = readyVisits
      .filter((v) => v.queueTicket?.ticketNumber)
      .map((v) => ({ ticketNumber: v.queueTicket!.ticketNumber }));

    return {
      siteId,
      siteName: site?.name ?? 'Service Centre',
      // Site-anchored so the public display's clock/date is correct on a lobby TV
      // regardless of the device's own timezone (CR-2026-079). PII-free.
      timezone: site?.timezone ?? 'America/Jamaica',
      generatedAt: now.toISOString(),
      totalInQueue: inQueue.length,
      inQueue,
      inService,
      ready,
    };
  }

  private getBlockedReason(sv: { queuePriorityClass: string | null }): string {
    if (sv.queuePriorityClass === 'BLOCKED_PARTS') return 'Missing required parts';
    if (sv.queuePriorityClass === 'BLOCKED_SKILL') return 'No qualified technician available';
    return 'Blocked';
  }

  /**
   * Average service-order duration (minutes) used to estimate queue ETA.
   *
   * CR-2026-007 — ETA average isolation (approved, docs/34). Two-tier:
   *  1. PRIMARY (LIVE): average of LIVE completed orders only — excludes
   *     HISTORICAL_IMPORT visits (reuses operational-scope `liveVisitSql('sv')`)
   *     and bounded to a rolling recency window. Used when the live sample is
   *     large enough to be reliable.
   *  2. FALLBACK (HISTORICAL_FALLBACK): when the live sample is below the
   *     threshold, fall back to the all-time set (incl. historical) for an
   *     early-pilot estimate, flagged as historical-derived.
   *  3. DEFAULT: the constant default when neither tier has data.
   *
   * Window + threshold are read from BusinessRuleConfig (not hard-coded);
   * documented defaults apply when no config row exists. This function only
   * affects the displayed ETA multiplier — it does NOT touch queueRank,
   * ranking, scheduling, assignment, or any write path.
   */
  private async getAvgServiceMinutes(siteId: string): Promise<AvgServiceResult> {
    try {
      const windowDays = await this.readEtaConfigNumber(
        siteId,
        'eta_avg_live_window_days',
        ETA_DEFAULT_WINDOW_DAYS,
      );
      const minLiveSample = await this.readEtaConfigNumber(
        siteId,
        'eta_avg_min_live_sample',
        ETA_DEFAULT_MIN_LIVE_SAMPLE,
      );
      const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

      // CR-2026-015 — optional outlier trimming. When configured (>0), restrict the
      // average to valid durations in (0, cap]; absent/0 ⇒ no clause ⇒ unchanged.
      const outlierCap = await this.readEtaConfigNumber(
        siteId,
        'eta_avg_outlier_cap_minutes',
        ETA_DEFAULT_OUTLIER_CAP_MINUTES,
      );
      const capSql =
        outlierCap > 0
          ? Prisma.sql`AND EXTRACT(EPOCH FROM (so.completed_at - so.started_at)) / 60 > 0
              AND EXTRACT(EPOCH FROM (so.completed_at - so.started_at)) / 60 <= ${outlierCap}`
          : Prisma.empty;
      if (outlierCap > 0) {
        this.logger.log(`ETA avg: outlier cap ${outlierCap}m applied for site ${siteId}`);
      }

      // Tier 1 — live completed orders within the rolling window.
      const live = await this.prisma.$queryRaw<Array<{ count: bigint; avg: number | null }>>`
        SELECT COUNT(*)::bigint AS count,
               AVG(EXTRACT(EPOCH FROM (so.completed_at - so.started_at)) / 60)::numeric(10,1) AS avg
        FROM service_orders so
        JOIN service_visits sv ON so.service_visit_id = sv.id
        WHERE sv.site_id = ${siteId}::uuid
          AND so.started_at IS NOT NULL
          AND so.completed_at IS NOT NULL
          AND so.completed_at >= ${windowStart}
          ${liveVisitSql('sv')}
          ${capSql}
      `;
      const liveCount = Number(live[0]?.count ?? 0);
      const liveAvg = live[0]?.avg != null ? Number(live[0].avg) : null;
      if (liveCount >= minLiveSample && liveAvg != null) {
        return { minutes: liveAvg, basis: 'LIVE', sampleSize: liveCount };
      }

      // Tier 2 — historical/all-time fallback (includes HISTORICAL_IMPORT),
      // only when the live sample is too small to be reliable.
      const hist = await this.prisma.$queryRaw<Array<{ count: bigint; avg: number | null }>>`
        SELECT COUNT(*)::bigint AS count,
               AVG(EXTRACT(EPOCH FROM (so.completed_at - so.started_at)) / 60)::numeric(10,1) AS avg
        FROM service_orders so
        JOIN service_visits sv ON so.service_visit_id = sv.id
        WHERE sv.site_id = ${siteId}::uuid
          AND so.started_at IS NOT NULL
          AND so.completed_at IS NOT NULL
          ${capSql}
      `;
      const histCount = Number(hist[0]?.count ?? 0);
      const histAvg = hist[0]?.avg != null ? Number(hist[0].avg) : null;
      if (histAvg != null) {
        this.logger.log(
          `ETA avg for site ${siteId}: HISTORICAL_FALLBACK (live sample ${liveCount} < ${minLiveSample}), ` +
            `using all-time avg ${histAvg}m over ${histCount} orders`,
        );
        return { minutes: histAvg, basis: 'HISTORICAL_FALLBACK', sampleSize: histCount };
      }

      // Tier 3 — no data anywhere.
      return { minutes: ETA_DEFAULT_MINUTES, basis: 'DEFAULT', sampleSize: 0 };
    } catch {
      return { minutes: ETA_DEFAULT_MINUTES, basis: 'DEFAULT', sampleSize: 0 };
    }
  }

  /**
   * Read a positive numeric BusinessRuleConfig value by key (site-aware),
   * falling back to the documented default when absent/invalid. Mirrors the
   * direct-read pattern used by schedule/maintenance services (CR-2026-007).
   */
  private async readEtaConfigNumber(
    siteId: string,
    ruleKey: string,
    fallback: number,
  ): Promise<number> {
    const rule = await this.prisma.businessRuleConfig.findFirst({
      where: { siteId, ruleKey },
      orderBy: { effectiveFrom: 'desc' },
    });
    const value = rule?.valueJson;
    return typeof value === 'number' && value > 0 ? value : fallback;
  }

  private async logEvent(
    serviceVisitId: string,
    queueTicketId: string,
    eventType: string,
    actorUserId: string | null,
    data: { positionBefore?: number | null; positionAfter?: number | null; reasonCode?: string },
  ) {
    try {
      await this.prisma.queueEvent.create({
        data: {
          serviceVisitId,
          queueTicketId,
          eventType,
          positionBefore: data.positionBefore ?? null,
          positionAfter: data.positionAfter ?? null,
          reasonCode: data.reasonCode,
          actorUserId,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log queue event: ${error}`);
    }
  }
}
