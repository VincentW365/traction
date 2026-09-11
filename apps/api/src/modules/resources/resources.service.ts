import { Injectable, NotFoundException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { EtaService } from '../scheduling/eta/eta.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { ETA_DEFAULTS, type EtaRuleValues } from '../scheduling/eta/eta.config';
import { presentEta } from '../../common/helpers/eta-presentation';
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
    // CR-2026-105b — optional so the existing specs' `new ResourcesService(prisma, audit)`
    // keeps working; at runtime both are injected by SchedulingModule.
    @Optional() private eta?: EtaService,
    @Optional() private scheduling?: SchedulingService,
  ) {}

  /** CR-2026-105b — ETA/overdue rules (site-aware) or the documented defaults. */
  private async loadEtaRules(siteId: string): Promise<EtaRuleValues> {
    if (!this.eta) return { ...ETA_DEFAULTS, overdueJobMinutes: AGING_MINUTES };
    try {
      return await this.eta.loadRules(siteId);
    } catch {
      return { ...ETA_DEFAULTS, overdueJobMinutes: AGING_MINUTES };
    }
  }

  /** CR-2026-105b — a bay changing hands changes every projection at the site. */
  private async republishEstimates(siteId: string): Promise<void> {
    if (!this.scheduling) return;
    try {
      await this.scheduling.recomputeQueue(siteId);
    } catch (err) {
      this.logger.error(`Queue recompute after resource change failed for site ${siteId}: ${(err as Error).message}`);
    }
  }

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
      include: { occupancy: true, operationalStatus: true },
    });
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    if (resource.occupancy?.status === 'OCCUPIED') {
      throw new BadRequestException(`Resource ${resource.code} is currently occupied`);
    }

    // CR-2026-095 — configuration is now live operational truth, so the gate sits
    // here at assignment, not only in the admin screen's filters. Each refusal names
    // its reason: "cannot assign" with no why is a radio call to the office.
    if (resource.retiredAt) {
      throw new BadRequestException(`${resource.name} is retired and cannot take new work.`);
    }
    if (!resource.isActive) {
      throw new BadRequestException(`${resource.name} is deactivated.`);
    }
    if (!resource.schedulingEnabled) {
      throw new BadRequestException(`${resource.name} is not accepting scheduled work.`);
    }
    const opState = resource.operationalStatus?.status ?? 'AVAILABLE';
    if (opState !== 'AVAILABLE') {
      const label = opState.replace(/_/g, ' ').toLowerCase();
      const back = resource.operationalStatus?.expectedReturnAt;
      throw new BadRequestException(
        `${resource.name} is ${label}${back ? ` (expected back ${back.toISOString().slice(0, 16).replace('T', ' ')})` : ''}.` +
          (resource.operationalStatus?.reason ? ` Reason: ${resource.operationalStatus.reason}` : ''),
      );
    }

    const ticket = await this.prisma.queueTicket.findUnique({
      where: { id: queueTicketId },
      include: { serviceVisit: { include: { vehicle: { select: { serviceClass: true } } } } },
    });
    if (!ticket) throw new NotFoundException(`Queue ticket ${queueTicketId} not found`);
    if (!['WAITING', 'PENDING_RANK'].includes(ticket.displayStatus)) {
      throw new BadRequestException(`Ticket is in status ${ticket.displayStatus}, cannot assign`);
    }

    // CR-2026-095 — structured vehicle-class compatibility. Checked BEFORE the
    // mobile-jack rule so an SUV against a sedan-only bay is refused as plain
    // incompatibility; the DMAIC gate below stays its own named safety rule with its
    // own audited override — an administrator unticking a checkbox cannot reach it.
    const vehicleClass = ticket.serviceVisit.vehicle?.serviceClass ?? null;
    if (vehicleClass === 'SUV_CLASS' && !resource.supportsSuv) {
      throw new BadRequestException(
        `${resource.name} is configured for sedans only — this vehicle is an SUV.`,
      );
    }
    if (vehicleClass === 'SEDAN_CLASS' && !resource.supportsSedan) {
      throw new BadRequestException(
        `${resource.name} is configured for SUVs only — this vehicle is a sedan.`,
      );
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
    await this.republishEstimates(resource.siteId);
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
    await this.republishEstimates(resource.siteId);
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
    // CR-2026-105b — the overdue threshold is a rule (overdue_job_minutes), and the
    // aging flag also honours the persisted estimate's confidence (DELAYED).
    const etaRules = await this.loadEtaRules(siteId);
    const agingMinutes = etaRules.overdueJobMinutes;
    const twoHoursAgo = new Date(now.getTime() - agingMinutes * 60 * 1000);
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
      pendingPauses,
      attentionNoteRows,
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
                  queueTicket: { select: { id: true, ticketNumber: true, queueRank: true, lastRankedAt: true } },
                  appointment: { select: { scheduledStartAt: true } },
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

      // --- CR-2026-100: technician pause requests awaiting acknowledgement ---
      this.prisma.serviceOrderPause.findMany({
        where: {
          approvalStatus: 'PENDING',
          endedAt: null,
          serviceOrder: { serviceVisit: { siteId, ...live } },
        },
        include: {
          serviceOrder: {
            select: {
              id: true,
              status: true,
              items: { select: { serviceType: { select: { name: true } } } },
              serviceVisit: {
                select: {
                  id: true,
                  customer: { select: { firstName: true, lastName: true } },
                  vehicle: { select: { plateNumber: true } },
                  queueTicket: { select: { id: true, ticketNumber: true } },
                },
              },
            },
          },
        },
        orderBy: { startedAt: 'asc' },
      }),

      // --- CR-2026-101: open attention items (safety flags, incorrect-data
      //     reports, technician requests) — surfaced for action, never buried ---
      this.prisma.visitNote.findMany({
        where: {
          requiresAttention: true,
          resolvedAt: null,
          serviceVisit: { siteId, ...live },
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
        orderBy: { createdAt: 'asc' },
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
      // CR-2026-105b — the authoritative estimate for the car on this resource.
      const etaView =
        isOccupied && sv
          ? presentEta({
              now,
              visitStatus: sv.status,
              queueRank: sv.queueTicket?.queueRank ?? null,
              orderStatuses: orders.map((o) => o.status),
              promisedCompletionAt: promisedAt,
              scheduledStartAt: sv.appointment?.scheduledStartAt ?? null,
              currentEtaStartAt: sv.currentEtaStartAt,
              currentEtaCompleteAt: sv.currentEtaCompleteAt,
              lastUpdatedAt: sv.queueTicket?.lastRankedAt ?? null,
              config: etaRules,
            })
          : null;
      const aging =
        isOccupied &&
        ((elapsedMinutes != null && elapsedMinutes > agingMinutes) || overPromised || etaView?.confidence === 'DELAYED');

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
                // CR-2026-105b — expected completion + On Track / At Risk / Delayed.
                eta: etaView,
                confidence: etaView?.confidence ?? null,
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
    // CR-2026-100 — a technician legitimately holds several jobs at once, so the
    // board distinguishes ACTIVE work (an IN_PROGRESS order) from HELD work
    // (paused / waiting on parts / waiting on the customer). A technician with
    // two jobs waiting on parts is far more available than one deep in a major
    // job — the workload breakdown says so instead of a single "busy" flag.
    const HELD_ORDER_STATUSES = new Set(['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER']);
    const technicianLoad = technicians.map((t) => {
      const openAssignments = t.assignments.length;
      const jobs = t.assignments.map((a) => ({
        serviceOrderId: a.serviceOrder.id,
        orderStatus: a.serviceOrder.status,
        held: HELD_ORDER_STATUSES.has(a.serviceOrder.status),
        ticketNumber: a.serviceOrder.serviceVisit.queueTicket?.ticketNumber ?? null,
        vehiclePlate: a.serviceOrder.serviceVisit.vehicle?.plateNumber ?? null,
        startedAt: a.startedAt,
        elapsedMinutes: minutesSince(a.startedAt),
      }));
      const activeJobs = jobs.filter((j) => j.orderStatus === 'IN_PROGRESS').length;
      const heldJobs = jobs.filter((j) => j.held).length;
      const working =
        t.assignments.find((a) => a.serviceOrder.status === 'IN_PROGRESS' && a.startedAt && !a.endedAt) ??
        null;
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
        activeJobs,
        heldJobs,
        jobs,
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

    // ---- pauseApprovals[] (CR-2026-100) ----
    // Never buried in an audit log: the advisor sees who reported the stop, why,
    // and how long it has waited for acknowledgement — and clicks into the job.
    const pauseApprovals = pendingPauses.map((p) => {
      const v = p.serviceOrder.serviceVisit;
      const tech = p.technicianId ? techNameById.get(p.technicianId) : undefined;
      return {
        pauseId: p.id,
        serviceOrderId: p.serviceOrder.id,
        orderStatus: p.serviceOrder.status,
        serviceVisitId: v.id,
        queueTicketId: v.queueTicket?.id ?? null,
        ticketNumber: v.queueTicket?.ticketNumber ?? null,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        serviceDescription:
          p.serviceOrder.items.map((i) => i.serviceType.name).join(' + ') || null,
        technicianName: tech?.fullName ?? null,
        reasonCode: p.reasonCode,
        notes: p.notes,
        requestedAt: p.startedAt,
        enteredOnBehalf: p.enteredOnBehalf,
        waitingMinutes: minutesSince(p.startedAt),
      };
    });

    // ---- attentionNotes[] (CR-2026-101) ----
    // Safety flags and incorrect-data reports from the floor: the technician
    // cannot (by design) edit master data, so the report comes here for action.
    const attentionNotes = attentionNoteRows.map((n) => {
      const v = n.serviceVisit;
      return {
        noteId: n.id,
        kind: n.kind,
        text: n.text,
        authorRole: n.authorRole,
        serviceVisitId: v.id,
        queueTicketId: v.queueTicket?.id ?? null,
        ticketNumber: v.queueTicket?.ticketNumber ?? null,
        customerName: fullName(v.customer),
        vehiclePlate: v.vehicle.plateNumber,
        createdAt: n.createdAt,
        waitingMinutes: minutesSince(n.createdAt),
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
        pauseApprovals: pauseApprovals.length,
        attentionNotes: attentionNotes.length,
      },
      resources: resourceCards,
      technicianLoad,
      needsDispatch,
      blocked,
      readyForQc,
      overdue,
      pauseApprovals,
      attentionNotes,
    };
  }
}
