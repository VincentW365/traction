import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { differenceInMinutes } from 'date-fns';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SchedulingService } from '../scheduling/scheduling.service';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private schedulingService: SchedulingService,
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
          status: { in: ['CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE'] },
        },
        displayStatus: {
          in: ['PENDING_RANK', 'WAITING', 'CALLED', 'IN_SERVICE', 'BLOCKED'],
        },
      },
      include: {
        serviceVisit: {
          include: {
            appointment: {
              include: { services: { include: { serviceType: true } } },
            },
          },
        },
      },
      orderBy: [{ queueRank: { sort: 'asc', nulls: 'last' } }],
    });

    const avgServiceMinutes = await this.getAvgServiceMinutes(siteId);

    const items = tickets.map((t) => {
      const sv = t.serviceVisit;
      const services = sv.appointment?.services ?? [];
      const serviceDescription =
        services.map((s) => s.serviceType.name).join(' + ') || 'Walk-in service';

      return {
        queueTicketId: t.id,
        ticketNumber: t.ticketNumber,
        fifoPosition: t.queueRank,
        displayStatus: t.displayStatus,
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

    return { siteId, generatedAt: now, items };
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
            appointment: {
              include: { services: { include: { serviceType: true } } },
            },
          },
        },
        queueEvents: { orderBy: { createdAt: 'desc' }, take: 30 },
      },
    });

    if (!ticket) throw new NotFoundException(`Queue ticket ${ticketId} not found`);
    return ticket;
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

  // ---------------------------------------------------------------------------
  // PUBLIC DISPLAY BOARD — sanitized, PII-free projection for the waiting-room
  // screen. NEVER include customer names, phones, emails, or full plates here:
  // this is rendered on a public screen visible to everyone in the lobby
  // (CLAUDE.md §10). Tickets are identified only by their (immutable) number.
  // ---------------------------------------------------------------------------

  async getPublicDisplayBoard(siteId: string) {
    const now = new Date();

    const [site, tickets, occupancies, readyVisits, avgServiceMinutes] =
      await Promise.all([
        this.prisma.site.findUnique({ where: { id: siteId }, select: { name: true } }),
        this.prisma.queueTicket.findMany({
          where: {
            serviceVisit: {
              siteId,
              status: { in: ['CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE'] },
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
        this.prisma.serviceVisit.findMany({
          where: { siteId, status: 'READY_FOR_PICKUP' },
          select: { queueTicket: { select: { ticketNumber: true } }, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        }),
        this.getAvgServiceMinutes(siteId),
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
        eta: this.getDisplayEtaLabel(t.queueRank, avgServiceMinutes),
      }));

    const ready = readyVisits
      .filter((v) => v.queueTicket?.ticketNumber)
      .map((v) => ({ ticketNumber: v.queueTicket!.ticketNumber }));

    return {
      siteId,
      siteName: site?.name ?? 'Service Centre',
      generatedAt: now.toISOString(),
      inQueue,
      inService,
      ready,
    };
  }

  private getDisplayEtaLabel(rank: number | null, avgMinutes: number): string {
    if (rank == null) return 'Shortly';
    const mins = rank * avgMinutes;
    if (mins <= 15) return '~15 min';
    if (mins <= 30) return '~30 min';
    if (mins <= 45) return '~45 min';
    if (mins <= 60) return '~1 hr';
    return '1 hr+';
  }

  private getBlockedReason(sv: { queuePriorityClass: string | null }): string {
    if (sv.queuePriorityClass === 'BLOCKED_PARTS') return 'Missing required parts';
    if (sv.queuePriorityClass === 'BLOCKED_SKILL') return 'No qualified technician available';
    return 'Blocked';
  }

  private async getAvgServiceMinutes(siteId: string): Promise<number> {
    try {
      const result = await this.prisma.$queryRaw<Array<{ avg: number | null }>>`
        SELECT AVG(
          EXTRACT(EPOCH FROM (so.completed_at - so.started_at)) / 60
        )::numeric(10,1) as avg
        FROM service_orders so
        JOIN service_visits sv ON so.service_visit_id = sv.id
        WHERE sv.site_id = ${siteId}::uuid
          AND so.started_at IS NOT NULL
          AND so.completed_at IS NOT NULL
      `;
      return result[0]?.avg ? Number(result[0].avg) : 30;
    } catch {
      return 30; // fallback 30 min
    }
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
