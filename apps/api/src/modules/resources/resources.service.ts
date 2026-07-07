import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { serviceVisitIsLive } from '../../common/helpers/operational-scope';

// CR-2026-080 — an assignment is "open" (counts toward technician load) while it
// has not ended. Filtering on `endedAt: null` is vocab-agnostic: the assignment
// status is written inconsistently across the codebase (ASSIGNED / ACTIVE /
// IN_PROGRESS on the open side; COMPLETED / REMOVED on the closed side), but every
// closed assignment stamps `endedAt`. The status guard is belt-and-suspenders.
const OPEN_ASSIGNMENT_WHERE: Prisma.TechnicianAssignmentWhereInput = {
  endedAt: null,
  status: { notIn: ['COMPLETED', 'REMOVED', 'CANCELLED'] },
};

// Aging threshold reused from the manager dashboard (CR-2026-074) — no new ETA math.
const AGING_MINUTES = 120;

@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async getDispatchBoard(siteId: string) {
    const resources = await this.prisma.workResource.findMany({
      where: { siteId, isActive: true },
      include: {
        operationalStatus: true, // CR-2026-065 — up/down state for the dispatch board
        occupancy: {
          include: {
            serviceVisit: {
              include: {
                customer: { select: { id: true, firstName: true, lastName: true } },
                vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
                queueTicket: { select: { ticketNumber: true, displayStatus: true } },
              },
            },
          },
        },
        reservations: {
          where: { status: { in: ['PENDING', 'ACTIVE'] } },
          include: {
            appointment: {
              include: {
                customer: { select: { firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { reservedFrom: 'asc' },
          take: 1,
        },
      },
      orderBy: { displayOrder: 'asc' },
    });

    return {
      siteId,
      generatedAt: new Date(),
      resources: resources.map((r) => {
        const occ = r.occupancy;
        const isOccupied = occ && occ.status === 'OCCUPIED';
        const nextReservation = r.reservations[0] ?? null;

        return {
          resourceId: r.id,
          code: r.code,
          name: r.name,
          resourceCategory: r.resourceCategory,
          maxVehicleWeight: r.maxVehicleWeight,
          liftType: r.liftType,
          hasAlignment: r.hasAlignment,
          hasDiagnostics: r.hasDiagnostics,
          requiresMechanic: r.requiresMechanic,
          isOperational: r.operationalStatus?.isOperational ?? true,
          operationalReason: r.operationalStatus?.reason ?? null,
          status: isOccupied ? 'OCCUPIED' : nextReservation ? 'RESERVED' : 'AVAILABLE',
          currentJob: isOccupied && occ.serviceVisit
            ? {
                serviceVisitId: occ.serviceVisit.id,
                ticketNumber: occ.serviceVisit.queueTicket?.ticketNumber ?? null,
                customerName: `${occ.serviceVisit.customer.firstName} ${occ.serviceVisit.customer.lastName}`,
                vehiclePlate: occ.serviceVisit.vehicle.plateNumber,
                vehicleDescription: [occ.serviceVisit.vehicle.make, occ.serviceVisit.vehicle.model].filter(Boolean).join(' '),
                startedAt: occ.occupiedAt,
                expectedEndAt: occ.expectedEndAt,
              }
            : null,
          nextReservation: nextReservation
            ? {
                appointmentId: nextReservation.appointmentId,
                customerName: `${nextReservation.appointment.customer.firstName} ${nextReservation.appointment.customer.lastName}`,
                reservedFrom: nextReservation.reservedFrom,
                reservedUntil: nextReservation.reservedUntil,
              }
            : null,
        };
      }),
    };
  }

  async assignToResource(
    resourceId: string,
    queueTicketId: string,
    technicianId: string | null,
    userId: string,
    options?: { mobileJackOverride?: boolean; overrideReason?: string },
  ) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id: resourceId },
      include: { occupancy: true },
    });
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    if (resource.occupancy?.status === 'OCCUPIED') {
      throw new BadRequestException(`Resource ${resource.code} is currently occupied`);
    }

    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: queueTicketId },
      include: { serviceVisit: { include: { vehicle: { select: { serviceClass: true } } } } },
    });
    if (!ticket) throw new NotFoundException(`Queue ticket ${queueTicketId} not found`);
    if (!['WAITING', 'PENDING_RANK'].includes(ticket.displayStatus)) {
      throw new BadRequestException(`Ticket is in status ${ticket.displayStatus}, cannot assign`);
    }

    // --- DMAIC Rule 3: mobile-jack sedan-only gate (with audited manager override) ---
    if (resource.liftType === 'mobile') {
      const serviceClass = ticket.serviceVisit.vehicle?.serviceClass ?? null;
      if (serviceClass !== 'SEDAN_CLASS') {
        const override = options?.mobileJackOverride === true;
        if (!override) {
          throw new BadRequestException(
            `Mobile jack ${resource.code} is sedan-only (DMAIC Rule 3); vehicle class is ${serviceClass ?? 'UNKNOWN'}. ` +
              `Use a stand, or apply a manager override.`,
          );
        }
        await this.audit.log({
          actorUserId: userId,
          action: AUDIT_ACTIONS.MOBILE_JACK_OVERRIDE,
          entityType: 'QueueTicket',
          entityId: queueTicketId,
          afterJson: { resourceCode: resource.code, resourceId, serviceClass: serviceClass ?? 'UNKNOWN' },
          reasonCode: 'MOBILE_JACK_OVERRIDE',
          notes: options?.overrideReason,
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.queueTicket.update({
        where: { id: queueTicketId },
        data: { displayStatus: 'CALLED' },
      });

      await tx.resourceOccupancy.upsert({
        where: { resourceId },
        update: {
          serviceVisitId: ticket.serviceVisitId,
          technicianId,
          status: 'OCCUPIED',
          occupiedAt: new Date(),
        },
        create: {
          resourceId,
          serviceVisitId: ticket.serviceVisitId,
          technicianId,
          status: 'OCCUPIED',
          occupiedAt: new Date(),
        },
      });

      await tx.queueEvent.create({
        data: {
          serviceVisitId: ticket.serviceVisitId,
          queueTicketId,
          eventType: 'ASSIGNED_TO_RESOURCE',
          positionBefore: ticket.queueRank,
          reasonCode: `assigned_to_${resource.code}`,
          actorUserId: userId,
        },
      });
    });

    this.logger.log(`Ticket ${ticket.ticketNumber} assigned to ${resource.code}`);
    return { message: `Assigned to ${resource.name}`, resourceCode: resource.code, ticketNumber: ticket.ticketNumber };
  }

  async releaseResource(resourceId: string, userId: string) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id: resourceId },
      include: { occupancy: { include: { serviceVisit: { include: { queueTicket: true } } } } },
    });
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);

    const visitId = resource.occupancy?.serviceVisitId;
    const ticketId = resource.occupancy?.serviceVisit?.queueTicket?.id;

    await this.prisma.resourceOccupancy.upsert({
      where: { resourceId },
      update: { status: 'AVAILABLE', serviceVisitId: null, technicianId: null, serviceOrderId: null },
      create: { resourceId, status: 'AVAILABLE' },
    });

    if (visitId && ticketId) {
      await this.prisma.queueEvent.create({
        data: {
          serviceVisitId: visitId,
          queueTicketId: ticketId,
          eventType: 'RESOURCE_RELEASED',
          reasonCode: `released_from_${resource.code}`,
          actorUserId: userId,
        },
      });
    }

    this.logger.log(`Resource ${resource.code} released`);
    return { message: `${resource.name} is now available`, resourceCode: resource.code };
  }

  async getReservations(siteId: string, date: string) {
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(`${date}T23:59:59Z`);

    return this.prisma.resourceReservation.findMany({
      where: {
        siteId,
        reservedFrom: { lte: dayEnd },
        reservedUntil: { gte: dayStart },
        status: { in: ['PENDING', 'ACTIVE', 'CLAIMED'] },
      },
      include: {
        resource: { select: { code: true, name: true } },
        appointment: {
          include: {
            customer: { select: { firstName: true, lastName: true } },
            services: { include: { serviceType: { select: { name: true } } } },
          },
        },
      },
      orderBy: { reservedFrom: 'asc' },
    });
  }

  /**
   * CR-2026-080 — unified dispatch overview read-model.
   *
   * Read-only projection that bridges the two resource systems the platform grew:
   *  - System A: WorkResource + ResourceOccupancy (drives the physical bay board)
   *  - System B: ServiceOrder + TechnicianAssignment (drives job execution)
   * They share only the ServiceVisit, so this endpoint joins them read-side to
   * surface, in one call, what neither model shows alone: who is working each bay,
   * per-technician load, unassigned/blocked/QC/overdue work, and aging flags.
   *
   * It changes NOTHING — no writes, no scheduling/ranking/ETA math (aging reuses the
   * existing 2h / promised-completion thresholds), no auto-assignment. Actions stay
   * on the existing endpoints; staff still confirm every assignment.
   */
  async getDispatchOverview(siteId: string) {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - AGING_MINUTES * 60 * 1000);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const live = serviceVisitIsLive();

    const [
      resources,
      technicians,
      needsDispatchTickets,
      blockedOrders,
      blockedTickets,
      qcOrders,
      overdueOrders,
    ] = await Promise.all([
      // --- System A: resources on the board, enriched via the visit's live orders ---
      this.prisma.workResource.findMany({
        where: { siteId, isActive: true, showOnDispatchBoard: true },
        include: {
          operationalStatus: true,
          reservations: {
            where: { status: { in: ['PENDING', 'ACTIVE'] } },
            include: { appointment: { include: { customer: { select: { firstName: true, lastName: true } } } } },
            orderBy: { reservedFrom: 'asc' },
            take: 1,
          },
          occupancy: {
            include: {
              serviceVisit: {
                include: {
                  customer: { select: { id: true, firstName: true, lastName: true } },
                  vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
                  queueTicket: { select: { id: true, ticketNumber: true } },
                  serviceOrders: {
                    where: { status: { notIn: ['CLOSED', 'CANCELLED'] } },
                    include: {
                      items: { include: { serviceType: { select: { name: true } } } },
                      assignments: {
                        where: OPEN_ASSIGNMENT_WHERE,
                        include: { technician: { select: { id: true, employeeCode: true, userAccount: { select: { fullName: true } } } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      }),

      // --- System B: every active technician + open load + current job + shift ---
      this.prisma.technician.findMany({
        where: { homeSiteId: siteId, status: 'ACTIVE' },
        include: {
          userAccount: { select: { fullName: true } },
          skills: { select: { skillCode: true, isPrimary: true } },
          availability: { where: { date: today }, select: { status: true, shiftStart: true, shiftEnd: true } },
          assignments: {
            where: OPEN_ASSIGNMENT_WHERE,
            include: {
              serviceOrder: {
                select: {
                  id: true,
                  status: true,
                  serviceVisit: {
                    select: {
                      vehicle: { select: { plateNumber: true } },
                      queueTicket: { select: { ticketNumber: true } },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { employeeCode: 'asc' },
      }),

      // --- Needs dispatch: checked-in tickets awaiting a bay ---
      this.prisma.queueTicket.findMany({
        where: {
          serviceVisit: { siteId, ...live, status: { in: ['CHECKED_IN', 'QUEUED'] } },
          displayStatus: { in: ['WAITING', 'PENDING_RANK'] },
        },
        include: {
          serviceVisit: {
            include: {
              customer: { select: { firstName: true, lastName: true } },
              vehicle: { select: { plateNumber: true, make: true, model: true } },
              appointment: { include: { services: { include: { serviceType: { select: { name: true } } } } } },
            },
          },
        },
        orderBy: [{ queueRank: { sort: 'asc', nulls: 'last' } }],
      }),

      // --- Blocked (System B): orders held on parts / paused / waiting on customer ---
      this.prisma.serviceOrder.findMany({
        where: { serviceVisit: { siteId, ...live }, status: { in: ['WAITING_PARTS', 'PAUSED', 'WAITING_CUSTOMER'] } },
        include: {
          items: { include: { serviceType: { select: { name: true } } } },
          serviceVisit: {
            select: {
              id: true,
              customer: { select: { firstName: true, lastName: true } },
              vehicle: { select: { plateNumber: true } },
              queueTicket: { select: { id: true, ticketNumber: true } },
            },
          },
        },
        orderBy: { updatedAt: 'asc' },
      }),

      // --- Blocked (System A): tickets the queue marked BLOCKED ---
      this.prisma.queueTicket.findMany({
        where: { serviceVisit: { siteId, ...live }, displayStatus: 'BLOCKED' },
        include: {
          serviceVisit: {
            select: {
              id: true,
              customer: { select: { firstName: true, lastName: true } },
              vehicle: { select: { plateNumber: true } },
            },
          },
        },
      }),

      // --- Ready for QC: technician finished, awaiting sign-off ---
      this.prisma.serviceOrder.findMany({
        where: { serviceVisit: { siteId, ...live }, status: 'QC' },
        include: {
          serviceVisit: {
            select: {
              id: true,
              customer: { select: { firstName: true, lastName: true } },
              vehicle: { select: { plateNumber: true } },
              queueTicket: { select: { id: true, ticketNumber: true } },
            },
          },
        },
        orderBy: { completedAt: 'asc' },
        take: 25,
      }),

      // --- Overdue: in-flight orders running past the aging threshold ---
      this.prisma.serviceOrder.findMany({
        where: {
          serviceVisit: { siteId, ...live },
          status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
          startedAt: { lt: twoHoursAgo, not: null },
        },
        include: {
          serviceVisit: {
            select: {
              id: true,
              customer: { select: { firstName: true, lastName: true } },
              vehicle: { select: { plateNumber: true } },
              queueTicket: { select: { id: true, ticketNumber: true } },
            },
          },
        },
        orderBy: { startedAt: 'asc' },
        take: 25,
      }),
    ]);

    const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`;
    const vehicleDesc = (v: { make: string | null; model: string | null }) =>
      [v.make, v.model].filter(Boolean).join(' ');
    const minutesSince = (d: Date | null | undefined) =>
      d ? Math.round((now.getTime() - new Date(d).getTime()) / 60000) : null;

    // technicianId -> display name, for resolving occupancy.technicianId fallbacks.
    const techNameById = new Map<string, { fullName: string; employeeCode: string }>();
    for (const t of technicians) {
      techNameById.set(t.id, { fullName: t.userAccount.fullName, employeeCode: t.employeeCode });
    }

    // ---- resources[] (enriched bay/resource view) ----
    const resourceCards = resources.map((r) => {
      const occ = r.occupancy;
      const isOccupied = !!occ && occ.status === 'OCCUPIED';
      const sv = isOccupied ? occ.serviceVisit : null;
      const nextReservation = r.reservations[0] ?? null;

      const orders = sv?.serviceOrders ?? [];
      const activeOrder =
        orders.find((o) =>
          ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER', 'QC'].includes(o.status),
        ) ??
        orders[0] ??
        null;

      // Assigned technician — prefer the System-B assignment (job truth); fall back
      // to the occupancy.technicianId column resolved through the site tech map.
      let technicianId: string | null = null;
      let technicianName: string | null = null;
      const primaryAssign =
        activeOrder?.assignments.find((a) => a.isPrimary) ?? activeOrder?.assignments[0] ?? null;
      if (primaryAssign) {
        technicianId = primaryAssign.technician.id;
        technicianName = primaryAssign.technician.userAccount.fullName;
      } else if (occ?.technicianId) {
        technicianId = occ.technicianId;
        technicianName = techNameById.get(occ.technicianId)?.fullName ?? null;
      }

      const serviceDescription = activeOrder
        ? activeOrder.items.map((i) => i.serviceType.name).join(' + ') || null
        : null;
      const partsBlocked =
        sv?.partsReadiness === 'REQUIRED_NOT_READY' || orders.some((o) => o.status === 'WAITING_PARTS');
      const promisedAt = activeOrder?.promisedCompletionAt ?? null;
      const elapsedMinutes = isOccupied ? minutesSince(occ.occupiedAt) : null;
      const overPromised = promisedAt ? now > new Date(promisedAt) : false;
      const aging = isOccupied && ((elapsedMinutes != null && elapsedMinutes > AGING_MINUTES) || overPromised);

      return {
        resourceId: r.id,
        code: r.code,
        name: r.name,
        resourceCategory: r.resourceCategory,
        maxVehicleWeight: r.maxVehicleWeight,
        liftType: r.liftType,
        hasAlignment: r.hasAlignment,
        hasDiagnostics: r.hasDiagnostics,
        requiresMechanic: r.requiresMechanic,
        isOperational: r.operationalStatus?.isOperational ?? true,
        operationalReason: r.operationalStatus?.reason ?? null,
        status: isOccupied ? 'OCCUPIED' : nextReservation ? 'RESERVED' : 'AVAILABLE',
        currentJob:
          isOccupied && sv
            ? {
                serviceVisitId: sv.id,
                serviceOrderId: activeOrder?.id ?? null,
                queueTicketId: sv.queueTicket?.id ?? null,
                ticketNumber: sv.queueTicket?.ticketNumber ?? null,
                customerName: fullName(sv.customer),
                vehiclePlate: sv.vehicle.plateNumber,
                vehicleDescription: vehicleDesc(sv.vehicle),
                technicianId,
                technicianName,
                serviceDescription,
                orderStatus: activeOrder?.status ?? null,
                partsBlocked,
                startedAt: occ.occupiedAt,
                expectedEndAt: occ.expectedEndAt,
                promisedCompletionAt: promisedAt,
                elapsedMinutes,
                aging,
              }
            : null,
        nextReservation: nextReservation
          ? {
              appointmentId: nextReservation.appointmentId,
              customerName: fullName(nextReservation.appointment.customer),
              reservedFrom: nextReservation.reservedFrom,
              reservedUntil: nextReservation.reservedUntil,
            }
          : null,
      };
    });

    // ---- technicianLoad[] ----
    const technicianLoad = technicians.map((t) => {
      const openAssignments = t.assignments.length;
      const working = t.assignments.find((a) => a.startedAt && !a.endedAt) ?? null;
      const shiftStatus = t.availability[0]?.status ?? 'NOT_SCHEDULED';
      const state: 'ABSENT' | 'BUSY' | 'ASSIGNED' | 'IDLE' =
        shiftStatus === 'ABSENT'
          ? 'ABSENT'
          : working
            ? 'BUSY'
            : openAssignments > 0
              ? 'ASSIGNED'
              : 'IDLE';
      return {
        technicianId: t.id,
        employeeCode: t.employeeCode,
        fullName: t.userAccount.fullName,
        skills: t.skills.map((s) => s.skillCode),
        openAssignments,
        state,
        shiftStatus,
        shift: t.availability[0] ? { start: t.availability[0].shiftStart, end: t.availability[0].shiftEnd } : null,
        currentJob: working
          ? {
              serviceOrderId: working.serviceOrder.id,
              orderStatus: working.serviceOrder.status,
              ticketNumber: working.serviceOrder.serviceVisit.queueTicket?.ticketNumber ?? null,
              vehiclePlate: working.serviceOrder.serviceVisit.vehicle?.plateNumber ?? null,
              startedAt: working.startedAt,
              elapsedMinutes: minutesSince(working.startedAt),
            }
          : null,
      };
    });

    // ---- needsDispatch[] ----
    const needsDispatch = needsDispatchTickets.map((t) => {
      const v = t.serviceVisit;
      const services = v.appointment?.services ?? [];
      return {
        queueTicketId: t.id,
        serviceVisitId: v.id,
        ticketNumber: t.ticketNumber,
        position: t.queueRank,
        displayStatus: t.displayStatus,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        vehicleDescription: vehicleDesc(v.vehicle),
        serviceDescription: services.map((s) => s.serviceType.name).join(' + ') || 'Walk-in service',
        partsReadiness: v.partsReadiness,
        blockedReason: t.blockedReason ?? null,
        waitingMinutes: minutesSince(v.checkedInAt),
      };
    });

    // ---- blocked[] (unified, deduped by visit) ----
    const blockedByVisit = new Set<string>();
    const blocked: Array<{
      serviceOrderId: string | null;
      queueTicketId: string | null;
      serviceVisitId: string;
      ticketNumber: string | null;
      customerName: string;
      vehiclePlate: string;
      reason: string;
      status: string;
      serviceDescription: string | null;
      blockedMinutes: number | null;
    }> = [];
    const blockedReasonForStatus = (s: string) =>
      s === 'WAITING_PARTS' ? 'Waiting on parts' : s === 'PAUSED' ? 'Paused' : 'Waiting on customer';
    for (const o of blockedOrders) {
      const v = o.serviceVisit;
      blockedByVisit.add(v.id);
      blocked.push({
        serviceOrderId: o.id,
        queueTicketId: v.queueTicket?.id ?? null,
        serviceVisitId: v.id,
        ticketNumber: v.queueTicket?.ticketNumber ?? null,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        reason: blockedReasonForStatus(o.status),
        status: o.status,
        serviceDescription: o.items.map((i) => i.serviceType.name).join(' + ') || null,
        blockedMinutes: minutesSince(o.updatedAt),
      });
    }
    for (const t of blockedTickets) {
      const v = t.serviceVisit;
      if (blockedByVisit.has(v.id)) continue; // already represented by an order-level block
      blocked.push({
        serviceOrderId: null,
        queueTicketId: t.id,
        serviceVisitId: v.id,
        ticketNumber: t.ticketNumber,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        reason: t.blockedReason ?? 'Blocked',
        status: 'BLOCKED',
        serviceDescription: null,
        blockedMinutes: minutesSince(t.generatedAt),
      });
    }

    // ---- readyForQc[] ----
    const readyForQc = qcOrders.map((o) => {
      const v = o.serviceVisit;
      return {
        serviceOrderId: o.id,
        serviceVisitId: v.id,
        queueTicketId: v.queueTicket?.id ?? null,
        ticketNumber: v.queueTicket?.ticketNumber ?? null,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        waitingMinutes: minutesSince(o.completedAt),
      };
    });

    // ---- overdue[] ----
    const overdue = overdueOrders.map((o) => {
      const v = o.serviceVisit;
      return {
        serviceOrderId: o.id,
        serviceVisitId: v.id,
        queueTicketId: v.queueTicket?.id ?? null,
        ticketNumber: v.queueTicket?.ticketNumber ?? null,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        orderStatus: o.status,
        elapsedMinutes: minutesSince(o.startedAt),
      };
    });

    return {
      siteId,
      generatedAt: now,
      summary: {
        resourcesTotal: resourceCards.length,
        available: resourceCards.filter((r) => r.isOperational && r.status === 'AVAILABLE').length,
        occupied: resourceCards.filter((r) => r.status === 'OCCUPIED').length,
        reserved: resourceCards.filter((r) => r.status === 'RESERVED').length,
        down: resourceCards.filter((r) => !r.isOperational).length,
        techniciansActive: technicianLoad.length,
        techniciansBusy: technicianLoad.filter((t) => t.state === 'BUSY').length,
        techniciansIdle: technicianLoad.filter((t) => t.state === 'IDLE').length,
        techniciansAbsent: technicianLoad.filter((t) => t.state === 'ABSENT').length,
        needsDispatch: needsDispatch.length,
        blocked: blocked.length,
        readyForQc: readyForQc.length,
        overdue: overdue.length,
      },
      resources: resourceCards,
      technicianLoad,
      needsDispatch,
      blocked,
      readyForQc,
      overdue,
    };
  }
}
