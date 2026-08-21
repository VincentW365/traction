import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { KpiService } from '../kpi/kpi.service';
import { WorkSegmentService } from '../kpi/work-segment.service';
import { CreateServiceOrderDto } from './dto/create-service-order.dto';
import { AssignTechnicianDto } from './dto/assign-technician.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import {
  PauseServiceOrderDto,
  ResumeServiceOrderDto,
  ReworkServiceOrderDto,
} from './dto/pause-rework.dto';
import { ServiceOrderStatus, WorkBay } from '@prisma/client';

// ---------------------------------------------------------------------------
// Valid status transitions for ServiceOrder
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, ServiceOrderStatus[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER', 'QC', 'CANCELLED'],
  PAUSED: ['IN_PROGRESS', 'CANCELLED'],
  WAITING_PARTS: ['IN_PROGRESS', 'CANCELLED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'CANCELLED'],
  // CR-2026-084 — a failed QC returns the order to APPROVED, not straight to
  // IN_PROGRESS. The technician's assignment is already ended when they send work
  // to QC, so resuming directly left the order "in progress" with nobody assigned
  // to it. Rework now has to be assigned again like any other work.
  QC: ['READY_TO_INVOICE', 'APPROVED', 'CANCELLED'],
  READY_TO_INVOICE: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

// Map ServiceOrder status to the corresponding ServiceVisit status
const ORDER_TO_VISIT_STATUS: Partial<Record<ServiceOrderStatus, string>> = {
  IN_PROGRESS: 'IN_SERVICE',
  WAITING_PARTS: 'WAITING_PARTS',
  QC: 'QC',
  READY_TO_INVOICE: 'READY_FOR_PICKUP',
};

/**
 * CR-2026-084 — map ServiceOrder status to the QueueTicket's display status.
 *
 * Nothing used to write `IN_SERVICE` to a queue ticket anywhere in production code,
 * so starting work updated the order and the visit but left the ticket reading
 * WAITING/CALLED. That single missing write is why the queue board never showed a
 * job as started, the customer's status link stayed on "in queue" while the car was
 * on the lift, and the technician's own card vanished.
 *
 * QueueDisplayStatus has no READY_FOR_PICKUP member, so a finished car stays
 * IN_SERVICE on the ticket until it is closed; the richer ServiceVisit status is
 * surfaced alongside it on the board instead.
 */
const ORDER_TO_TICKET_STATUS: Partial<Record<ServiceOrderStatus, string>> = {
  IN_PROGRESS: 'IN_SERVICE',
  QC: 'IN_SERVICE',
  READY_TO_INVOICE: 'IN_SERVICE',
  // Back out of the working states: the car rejoins the waiting line and the next
  // recompute gives it a position again.
  APPROVED: 'WAITING',
};

// Transitions that should trigger a queue recompute
const RECOMPUTE_TRIGGERS = new Set<ServiceOrderStatus>([
  // CR-2026-084 — rework sends an order back to APPROVED; the car rejoins the
  // waiting line and needs a position again.
  'APPROVED' as ServiceOrderStatus,
  'ASSIGNED' as ServiceOrderStatus,
  'IN_PROGRESS' as ServiceOrderStatus,
  'WAITING_PARTS' as ServiceOrderStatus,
  'WAITING_CUSTOMER' as ServiceOrderStatus,
  'QC' as ServiceOrderStatus,
  // CR-2026-075 — the "vehicle is ready for pickup" moment; refresh the boards promptly.
  'READY_TO_INVOICE' as ServiceOrderStatus,
  'CANCELLED' as ServiceOrderStatus,
]);

@Injectable()
export class ServiceOrdersService {
  private readonly logger = new Logger(ServiceOrdersService.name);

  constructor(
    private prisma: PrismaService,
    private statusHistory: StatusHistoryService,
    private auditService: AuditService,
    private schedulingService: SchedulingService,
    // CR-2026-088 — KPI hooks at the two moments that define the measurement:
    // start of work, and the first submission to QC.
    private kpi: KpiService,
    // CR-2026-090 — per-technician labour segments. Hooked at every point work
    // starts or stops for a person: start, pause, resume, reassign, assist, QC.
    private segments: WorkSegmentService,
  ) {}

  // ---------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------

  async create(data: CreateServiceOrderDto, userId: string) {
    if (!data.items || data.items.length === 0) {
      throw new BadRequestException(
        'At least one service item is required',
      );
    }

    // 1. Validate the service visit exists and is in a valid state
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: data.serviceVisitId },
    });

    if (!visit) {
      throw new NotFoundException(
        `ServiceVisit ${data.serviceVisitId} not found`,
      );
    }

    // 2. Resolve service type codes to IDs
    const serviceTypeMap = await this.resolveServiceTypeCodes(
      data.items.map((item) => item.serviceTypeCode),
    );

    // 3. Create ServiceOrder + ServiceOrderItems in a transaction
    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.serviceOrder.create({
        data: {
          serviceVisitId: data.serviceVisitId,
          advisorUserId: userId,
          status: 'DRAFT',
          promisedCompletionAt: data.promisedCompletionAt
            ? new Date(data.promisedCompletionAt)
            : undefined,
          notes: data.notes,
          items: {
            create: data.items.map((item) => {
              const serviceType = serviceTypeMap.get(item.serviceTypeCode)!;
              return {
                serviceTypeId: serviceType.id,
                estimateMinutes:
                  item.estimateMinutes ?? serviceType.baseDurationMinutes,
                notes: item.notes,
                // CR-2026-090 — see ServiceOrderItemDto: brake lines carry no axle
                // in the service code, so it is captured on the line itself.
                axlePosition: (item.axlePosition ?? null) as never,
              };
            }),
          },
        },
        include: {
          items: { include: { serviceType: true } },
          serviceVisit: true,
        },
      });

      return created;
    });

    // 4. Record status history: null -> DRAFT
    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: order.id,
      fromStatus: null,
      toStatus: 'DRAFT',
      changedByUserId: userId,
    });

    this.logger.log(
      `ServiceOrder ${order.id} created for visit ${data.serviceVisitId} with ${data.items.length} item(s)`,
    );

    return order;
  }

  // ---------------------------------------------------------------------------
  // FIND BY ID
  // ---------------------------------------------------------------------------

  async findById(id: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id },
      include: {
        items: { include: { serviceType: true } },
        assignments: {
          include: {
            technician: true,
            bay: true,
          },
        },
        serviceVisit: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`ServiceOrder ${id} not found`);
    }

    return order;
  }

  // ---------------------------------------------------------------------------
  // FIND BY VISIT
  // ---------------------------------------------------------------------------

  async findByVisit(serviceVisitId: string) {
    return this.prisma.serviceOrder.findMany({
      where: { serviceVisitId },
      orderBy: { createdAt: 'asc' },
      include: {
        items: { include: { serviceType: true } },
        assignments: {
          include: {
            technician: true,
            bay: true,
          },
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // UPDATE / DELETE (before work is assigned) — CR-2026-071
  // ---------------------------------------------------------------------------

  /** Only DRAFT/APPROVED orders (before a technician is assigned) may be edited/deleted. */
  private assertEditableStatus(status: string, verb: 'edit' | 'delete') {
    if (!['DRAFT', 'APPROVED'].includes(status)) {
      throw new BadRequestException(
        `Cannot ${verb} a service order in status ${status} — only DRAFT or APPROVED (before work is assigned).`,
      );
    }
  }

  async updateOrder(
    id: string,
    dto: {
      items?: Array<{
        serviceTypeCode: string;
        estimateMinutes?: number;
        notes?: string;
        axlePosition?: string;
      }>;
      notes?: string;
    },
    userId: string,
  ) {
    const order = await this.findById(id);
    this.assertEditableStatus(order.status, 'edit');

    let resolved: Awaited<ReturnType<typeof this.resolveServiceTypeCodes>> | null = null;
    if (dto.items) {
      if (dto.items.length === 0) {
        throw new BadRequestException('A service order must have at least one item.');
      }
      resolved = await this.resolveServiceTypeCodes(dto.items.map((i) => i.serviceTypeCode));
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.items && resolved) {
        await tx.serviceOrderItem.deleteMany({ where: { serviceOrderId: id } });
        await tx.serviceOrderItem.createMany({
          data: dto.items.map((item) => {
            const serviceType = resolved!.get(item.serviceTypeCode)!;
            return {
              serviceOrderId: id,
              serviceTypeId: serviceType.id,
              estimateMinutes: item.estimateMinutes ?? serviceType.baseDurationMinutes,
              notes: item.notes,
              axlePosition: (item.axlePosition ?? null) as never,
            };
          }),
        });
      }
      return tx.serviceOrder.update({
        where: { id },
        data: { ...(dto.notes !== undefined && { notes: dto.notes }) },
        include: {
          items: { include: { serviceType: true } },
          assignments: { include: { technician: true, bay: true } },
          serviceVisit: true,
        },
      });
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'SERVICE_ORDER_UPDATED',
      entityType: 'ServiceOrder',
      entityId: id,
      afterJson: { items: dto.items?.map((i) => i.serviceTypeCode), notes: dto.notes },
    });

    // CR-2026-088 — a scope change can move the job to a different benchmark
    // package, so re-evaluate and record the revision. Only ever applies before the
    // result is known; a finalised snapshot is left alone.
    if (dto.items) {
      try {
        await this.kpi.reevaluatePackage(id, userId);
      } catch (err) {
        this.logger.error(
          `KPI package re-evaluation failed for order ${id}: ${(err as Error).message}`,
        );
      }
    }

    // Line items drive duration estimates — refresh the queue.
    await this.triggerQueueRecompute(order.serviceVisit.siteId);
    this.logger.log(`ServiceOrder ${id} edited by ${userId}`);
    return updated;
  }

  /**
   * CR-2026-090 — record which axle a service line covers.
   *
   * Allowed at any point before the KPI result is frozen, because the axle is a fact
   * about the work rather than a judgement about it, and the alternative — a job
   * permanently unbenchmarked because a dropdown was missed at booking — helps
   * nobody.
   *
   * Re-evaluating the package afterwards is the point: a job blocked only by a
   * missing axle becomes benchmarked the moment the axle is known. That runs through
   * the same audited path as any other scope change, and `reevaluatePackage` refuses
   * once the snapshot is finalised, so a completed job's terms cannot be revised
   * after its result is known.
   */
  async setItemAxle(
    orderId: string,
    itemId: string,
    axlePosition: string,
    userId: string,
  ) {
    const item = await this.prisma.serviceOrderItem.findFirst({
      where: { id: itemId, serviceOrderId: orderId },
      include: { serviceType: { select: { code: true, name: true } } },
    });
    if (!item) {
      throw new NotFoundException(`Service line ${itemId} not found on order ${orderId}`);
    }

    if (item.axlePosition === (axlePosition as never)) return item;

    const updated = await this.prisma.serviceOrderItem.update({
      where: { id: itemId },
      data: { axlePosition: axlePosition as never },
      include: { serviceType: { select: { code: true, name: true } } },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'SERVICE_LINE_AXLE_SET',
      entityType: 'ServiceOrderItem',
      entityId: itemId,
      beforeJson: { axlePosition: item.axlePosition },
      afterJson: { axlePosition, serviceCode: updated.serviceType.code },
    });

    try {
      await this.kpi.reevaluatePackage(orderId, userId);
    } catch (err) {
      this.logger.error(
        `KPI package re-evaluation failed for order ${orderId}: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Axle set to ${axlePosition} on ${updated.serviceType.code} (order ${orderId}) by ${userId}`,
    );
    return updated;
  }

  /**
   * CR-2026-092 — record the structured qualifiers a conditional service needs.
   *
   * Supersedes setting the axle alone: a brake line needs a work type as well, because
   * front pads, rear shoes and a fluid bleed are different jobs measured differently.
   * Any subset may be supplied, so a screen can save each answer as it is given rather
   * than forcing the whole set at once.
   */
  async setItemQualifiers(
    orderId: string,
    itemId: string,
    q: {
      axlePosition?: string;
      brakeWorkType?: string;
      tireOperation?: string;
      unitQuantity?: number;
    },
    userId: string,
  ) {
    const item = await this.prisma.serviceOrderItem.findFirst({
      where: { id: itemId, serviceOrderId: orderId },
      include: { serviceType: { select: { code: true, name: true } } },
    });
    if (!item) {
      throw new NotFoundException(`Service line ${itemId} not found on order ${orderId}`);
    }

    const data: Record<string, unknown> = {};
    if (q.axlePosition !== undefined) data.axlePosition = q.axlePosition;
    if (q.brakeWorkType !== undefined) data.brakeWorkType = q.brakeWorkType;
    if (q.tireOperation !== undefined) data.tireOperation = q.tireOperation;
    if (q.unitQuantity !== undefined) data.unitQuantity = q.unitQuantity;
    if (Object.keys(data).length === 0) return item;

    const updated = await this.prisma.serviceOrderItem.update({
      where: { id: itemId },
      data: data as never,
      include: { serviceType: { select: { code: true, name: true } } },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'SERVICE_LINE_QUALIFIERS_SET',
      entityType: 'ServiceOrderItem',
      entityId: itemId,
      beforeJson: {
        axlePosition: item.axlePosition,
        brakeWorkType: item.brakeWorkType,
        tireOperation: item.tireOperation,
        unitQuantity: item.unitQuantity,
      },
      afterJson: { ...data, serviceCode: updated.serviceType.code },
    });

    // Supplying a qualifier can turn an unrateable job into a rateable one, so the
    // standard is re-derived immediately rather than at the finish line.
    try {
      await this.kpi.reevaluatePackage(orderId, userId);
    } catch (err) {
      this.logger.error(
        `KPI re-evaluation failed for order ${orderId}: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Qualifiers set on ${updated.serviceType.code} (order ${orderId}) by ${userId}: ` +
        JSON.stringify(data),
    );
    return updated;
  }

  /**
   * CR-2026-092 — is this job ready to be measured?
   *
   * Read before Start Work, and available to the work-order screen so the answer
   * arrives while somebody can still act on it. The failure this prevents is
   * discovering at submit-to-QC that a brake line never said which axle — by then the
   * technician has done the work and the job cannot be rated, which reads to them as
   * being punished for a form they never saw.
   */
  async getBenchmarkReadiness(orderId: string) {
    const [calc, display] = await Promise.all([
      this.kpi.calculateStandardForOrder(orderId),
      // The same display-shaped breakdown the live endpoint emits, so a screen showing
      // both never has to reconcile two shapes of the same arithmetic.
      this.kpi.getCalculationBreakdown(orderId),
    ]);

    return {
      ready: calc.missingQualifiers.length === 0 && calc.unmappedServiceTypeIds.length === 0,
      missingQualifiers: calc.missingQualifiers,
      unmappedServiceTypeIds: calc.unmappedServiceTypeIds,
      finalStandardMinutes: calc.finalStandardMinutes,
      benchmarkSource: calc.benchmarkSource,
      vehicleClass: display.vehicleClass,
      calculationBreakdown: display.breakdown,
      calculation: calc,
    };
  }

  async deleteOrder(id: string, userId: string) {
    const order = await this.findById(id);
    this.assertEditableStatus(order.status, 'delete');

    const activeAssignments = order.assignments.filter(
      (a) => a.endedAt === null && a.status !== 'REMOVED',
    );
    if (activeAssignments.length > 0) {
      throw new BadRequestException(
        'Cannot delete a service order with a technician assigned — remove the assignment first.',
      );
    }

    await this.prisma.serviceOrder.delete({ where: { id } }); // items cascade

    await this.auditService.log({
      actorUserId: userId,
      action: 'SERVICE_ORDER_DELETED',
      entityType: 'ServiceOrder',
      entityId: id,
      beforeJson: {
        status: order.status,
        serviceVisitId: order.serviceVisitId,
        items: order.items.map((i) => i.serviceType.code),
      },
    });

    await this.triggerQueueRecompute(order.serviceVisit.siteId);
    this.logger.log(`ServiceOrder ${id} deleted by ${userId}`);
    return { deleted: true };
  }

  // ---------------------------------------------------------------------------
  // APPROVE
  // ---------------------------------------------------------------------------

  async approve(id: string, userId: string) {
    const order = await this.findById(id);

    if (order.status !== 'DRAFT') {
      throw new BadRequestException(
        `Cannot approve service order in status ${order.status} — must be DRAFT`,
      );
    }

    const updated = await this.prisma.serviceOrder.update({
      where: { id },
      data: { status: 'APPROVED' },
      include: {
        items: { include: { serviceType: true } },
        assignments: { include: { technician: true, bay: true } },
        serviceVisit: true,
      },
    });

    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: id,
      fromStatus: 'DRAFT',
      toStatus: 'APPROVED',
      changedByUserId: userId,
    });

    this.logger.log(`ServiceOrder ${id} approved by ${userId}`);

    return updated;
  }

  // ---------------------------------------------------------------------------
  // ASSIGN
  // ---------------------------------------------------------------------------

  async assign(id: string, dto: AssignTechnicianDto, userId: string) {
    const order = await this.findById(id);

    if (order.status !== 'APPROVED' && order.status !== 'ASSIGNED') {
      throw new BadRequestException(
        `Cannot assign technician to service order in status ${order.status} — must be APPROVED or ASSIGNED`,
      );
    }

    // 1. Load the technician with skills
    const technician = await this.prisma.technician.findUnique({
      where: { id: dto.technicianId },
      include: { skills: true },
    });

    if (!technician) {
      throw new NotFoundException(
        `Technician ${dto.technicianId} not found`,
      );
    }

    if (technician.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Technician ${dto.technicianId} is not active`,
      );
    }

    // 2. Validate technician has the required skills
    const requiredSkills = order.items
      .map((item) => item.serviceType.requiredSkillCode)
      .filter((code): code is string => code != null);

    const techSkillCodes = new Set(
      technician.skills.map((s) => s.skillCode),
    );

    const missingSkills = requiredSkills.filter(
      (code) => !techSkillCodes.has(code),
    );

    if (missingSkills.length > 0) {
      throw new BadRequestException(
        `Technician lacks required skill(s): ${[...new Set(missingSkills)].join(', ')}`,
      );
    }

    // 3. Resolve the bay: use the one provided, else auto-assign the first
    //    compatible + free bay (CR-2026-062).
    let bay: WorkBay;
    if (dto.bayId) {
      const found = await this.prisma.workBay.findUnique({ where: { id: dto.bayId } });

      if (!found) {
        throw new NotFoundException(`Work bay ${dto.bayId} not found`);
      }

      if (found.status !== 'ACTIVE') {
        throw new BadRequestException(`Work bay ${dto.bayId} is not active`);
      }

      // Validate bay type matches required bay types
      const requiredBayTypes = order.items
        .map((item) => item.serviceType.requiredBayType)
        .filter((bt): bt is string => bt != null);

      if (requiredBayTypes.length > 0 && !requiredBayTypes.includes(found.bayType)) {
        throw new BadRequestException(
          `Bay type '${found.bayType}' does not match required bay type(s): ${[...new Set(requiredBayTypes)].join(', ')}`,
        );
      }
      bay = found;
    } else {
      const picked = await this.pickCompatibleFreeBay(order);
      if (!picked) {
        throw new BadRequestException(
          'No compatible free bay is available — free one up or assign a bay manually.',
        );
      }
      bay = picked;
    }

    // 4. Check for double-booking: technician not in an active assignment ON A
    //    DIFFERENT visit. Multiple orders on the SAME visit (same vehicle) are the
    //    same job, so the tech may hold all of them (CR-2026-068).
    const activeAssignment = await this.prisma.technicianAssignment.findFirst({
      where: {
        technicianId: dto.technicianId,
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        endedAt: null,
        serviceOrder: { serviceVisitId: { not: order.serviceVisitId } },
      },
    });

    if (activeAssignment) {
      throw new BadRequestException(
        `Technician ${dto.technicianId} already has an active assignment on another visit (${activeAssignment.id})`,
      );
    }

    // 5. Create TechnicianAssignment and update order status
    const [assignment, updated] = await this.prisma.$transaction(
      async (tx) => {
        const newAssignment = await tx.technicianAssignment.create({
          data: {
            serviceOrderId: id,
            technicianId: dto.technicianId,
            bayId: bay.id,
            isPrimary: true,
            status: 'ASSIGNED',
          },
          include: {
            technician: true,
            bay: true,
          },
        });

        const updatedOrder = await tx.serviceOrder.update({
          where: { id },
          data: { status: 'ASSIGNED' },
          include: {
            items: { include: { serviceType: true } },
            assignments: { include: { technician: true, bay: true } },
            serviceVisit: true,
          },
        });

        return [newAssignment, updatedOrder] as const;
      },
    );

    // 6. Record status history
    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: id,
      fromStatus: order.status,
      toStatus: 'ASSIGNED',
      changedByUserId: userId,
      notes: `Technician ${technician.employeeCode} assigned to bay ${bay.code}`,
    });

    // 7. Trigger queue recompute
    await this.triggerQueueRecompute(order.serviceVisit.siteId);

    this.logger.log(
      `ServiceOrder ${id} assigned to technician ${dto.technicianId} in bay ${bay.id}${dto.bayId ? '' : ' (auto-assigned)'}`,
    );

    return updated;
  }

  /**
   * CR-2026-068 — assign one technician to ALL of a visit's APPROVED service orders in
   * a single action (each order gets an auto-selected compatible free bay). Reuses
   * assign() per order, so skill/bay validation and the same-visit-aware double-booking
   * guard all apply. Returns the updated orders.
   */
  async assignAllForVisit(visitId: string, technicianId: string, userId: string) {
    const orders = await this.prisma.serviceOrder.findMany({
      where: { serviceVisitId: visitId, status: 'APPROVED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (orders.length === 0) {
      throw new BadRequestException('No approved service orders to assign for this visit.');
    }
    const updated = [];
    for (const o of orders) {
      updated.push(await this.assign(o.id, { technicianId } as AssignTechnicianDto, userId));
    }
    return updated;
  }

  /**
   * CR-2026-069 — the logged-in technician's own assignments (default: not-yet-started,
   * so they can start their work). Returns a compact, floor-friendly shape. Non-technician
   * users have no technician record and get an empty list.
   */
  /**
   * CR-2026-084 — the technician's own live work.
   *
   * This used to filter on a single status defaulting to ASSIGNED, so the moment a
   * technician pressed START WORK their job flipped to IN_PROGRESS and dropped out
   * of their own list — the card vanished and nothing replaced it. It now returns
   * every still-open assignment and reports each one's order status, so the screen
   * can show "ready to start" and "working on now" from one authoritative source
   * that is genuinely scoped to this technician.
   */
  async getMyAssignments(userId: string, status?: string) {
    const tech = await this.prisma.technician.findUnique({
      where: { userAccountId: userId },
    });
    if (!tech) return [];

    const statuses = status
      ? [status]
      : ['ASSIGNED', 'IN_PROGRESS', 'PAUSED'];

    const assignments = await this.prisma.technicianAssignment.findMany({
      where: { technicianId: tech.id, status: { in: statuses }, endedAt: null },
      include: {
        bay: { select: { code: true } },
        serviceOrder: {
          include: {
            items: { include: { serviceType: { select: { name: true } } } },
            serviceVisit: {
              include: {
                customer: { select: { firstName: true, lastName: true } },
                vehicle: { select: { plateNumber: true, make: true, model: true } },
                queueTicket: { select: { ticketNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });

    return assignments.map((a) => {
      const visit = a.serviceOrder.serviceVisit;
      return {
        assignmentId: a.id,
        orderId: a.serviceOrderId,
        orderStatus: a.serviceOrder.status,
        // CR-2026-084 — the technician screen renders "ready to start" vs "working
        // on now" from these, instead of guessing from the site-wide queue board.
        assignmentStatus: a.status,
        startedAt: a.serviceOrder.startedAt,
        serviceVisitId: a.serviceOrder.serviceVisitId,
        ticketNumber: visit.queueTicket?.ticketNumber ?? null,
        customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
        vehicle:
          [visit.vehicle.make, visit.vehicle.model].filter(Boolean).join(' ') ||
          visit.vehicle.plateNumber,
        plate: visit.vehicle.plateNumber,
        bay: a.bay?.code ?? null,
        services: a.serviceOrder.items.map((i) => i.serviceType.name),
      };
    });
  }

  /**
   * CR-2026-062 — pick the first ACTIVE bay that (a) matches the order's required
   * bay type(s) — or any active bay if the order has no bay-type requirement — and
   * (b) has no active technician assignment. Returns null when none is free.
   */
  private async pickCompatibleFreeBay(order: {
    items: Array<{ serviceType: { requiredBayType: string | null } }>;
    serviceVisit: { siteId: string };
  }) {
    const requiredBayTypes = [
      ...new Set(
        order.items
          .map((item) => item.serviceType.requiredBayType)
          .filter((bt): bt is string => bt != null),
      ),
    ];

    const candidates = await this.prisma.workBay.findMany({
      where: {
        siteId: order.serviceVisit.siteId,
        status: 'ACTIVE',
        ...(requiredBayTypes.length > 0 ? { bayType: { in: requiredBayTypes } } : {}),
      },
      orderBy: { code: 'asc' },
    });

    for (const candidate of candidates) {
      const active = await this.prisma.technicianAssignment.findFirst({
        where: {
          bayId: candidate.id,
          status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
          endedAt: null,
        },
      });
      if (!active) return candidate;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // CHANGE STATUS
  // ---------------------------------------------------------------------------

  async changeStatus(id: string, dto: ChangeStatusDto, userId: string) {
    const order = await this.findById(id);
    const fromStatus = order.status;
    const toStatus = dto.toStatus as ServiceOrderStatus;

    // Validate the target status is a valid enum value
    if (!Object.values(ServiceOrderStatus).includes(toStatus)) {
      throw new BadRequestException(
        `Invalid target status: ${dto.toStatus}`,
      );
    }

    // Validate the transition is legal
    const allowedTargets = VALID_TRANSITIONS[fromStatus] ?? [];
    if (!allowedTargets.includes(toStatus)) {
      throw new BadRequestException(
        `Invalid status transition: ${fromStatus} -> ${toStatus}`,
      );
    }

    // CR-2026-087 — passing the quality check is now attributed and guarded.
    // It used to be an ordinary status transition: nothing recorded who passed it,
    // and nothing stopped the technician who did the work from signing off their
    // own job. (A FAILED check was already attributed, via ServiceOrderRework.)
    if (fromStatus === 'QC' && toStatus === 'READY_TO_INVOICE') {
      await this.assertQcNotSelfApproved(id, userId);
    }

    // Build update data with appropriate timestamp fields
    const updateData: Record<string, unknown> = { status: toStatus };

    if (fromStatus === 'QC' && toStatus === 'READY_TO_INVOICE') {
      updateData.qcByUserId = userId;
      updateData.qcAt = new Date();
    }

    if (toStatus === 'IN_PROGRESS' && !order.startedAt) {
      updateData.startedAt = new Date();
    }
    if (toStatus === 'QC') {
      updateData.completedAt = new Date();
    }
    if (toStatus === 'CLOSED') {
      updateData.closedAt = new Date();
    }

    // Update the service order
    const updated = await this.prisma.serviceOrder.update({
      where: { id },
      data: updateData,
      include: {
        items: { include: { serviceType: true } },
        assignments: { include: { technician: true, bay: true } },
        serviceVisit: true,
      },
    });

    // CR-2026-090 — a cancelled job stops the labour clock. Without this, an open
    // segment on a cancelled order keeps accruing against "now" every time a report
    // is run, and the technician's labour grows indefinitely for a job nobody is
    // doing.
    if (toStatus === 'CANCELLED') {
      await this.segments.endAllForOrder({
        serviceOrderId: id,
        endReason: 'JOB_CANCELLED',
        actorUserId: userId,
      });
    }

    // Record status history
    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: id,
      fromStatus,
      toStatus,
      changedByUserId: userId,
      reasonCode: dto.reasonCode,
      notes: dto.notes,
    });

    // Update the ServiceVisit status to match when applicable
    const visitStatus = ORDER_TO_VISIT_STATUS[toStatus];
    if (visitStatus) {
      await this.prisma.serviceVisit.update({
        where: { id: order.serviceVisitId },
        data: { status: visitStatus as any },
      });

      await this.statusHistory.record({
        entityType: 'ServiceVisit',
        entityId: order.serviceVisitId,
        fromStatus: order.serviceVisit.status,
        toStatus: visitStatus,
        changedByUserId: userId,
        reasonCode: 'ORDER_STATUS_SYNC',
        notes: `Synced from ServiceOrder ${id} transition to ${toStatus}`,
      });
    }

    // CR-2026-084 — keep the queue ticket in step with the work.
    await this.syncQueueTicket(order.serviceVisitId, toStatus);

    // End technician assignments on terminal statuses
    if (toStatus === 'CANCELLED' || toStatus === 'CLOSED') {
      await this.prisma.technicianAssignment.updateMany({
        where: {
          serviceOrderId: id,
          endedAt: null,
        },
        data: {
          endedAt: new Date(),
          status: toStatus === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED',
        },
      });
    }

    // Trigger queue recompute on relevant transitions
    if (RECOMPUTE_TRIGGERS.has(toStatus)) {
      await this.triggerQueueRecompute(order.serviceVisit.siteId);
    }

    this.logger.log(
      `ServiceOrder ${id} status changed: ${fromStatus} -> ${toStatus} by ${userId}`,
    );

    return updated;
  }

  // ---------------------------------------------------------------------------
  // PAUSE / RESUME  (CR-2026-001, recording-only — NO scheduling/ETA/rank impact)
  // ---------------------------------------------------------------------------

  async pause(id: string, dto: PauseServiceOrderDto, userId: string) {
    const order = await this.findById(id);
    if (!(VALID_TRANSITIONS[order.status] ?? []).includes('PAUSED' as ServiceOrderStatus)) {
      throw new BadRequestException(
        `Cannot pause a service order in status ${order.status} — must be IN_PROGRESS`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const so = await tx.serviceOrder.update({ where: { id }, data: { status: 'PAUSED' } });
      await tx.serviceOrderPause.create({
        data: {
          serviceOrderId: id,
          reasonCode: dto.reasonCode,
          pausedByUserId: userId,
          notes: dto.notes,
        },
      });

      // CR-2026-090 — pausing stops the labour clock for everyone on the job.
      //
      // Inside the same transaction as the pause itself, because a pause recorded
      // without its segments closed would leave technicians accruing labour through
      // time the job was explicitly stopped, and that error is invisible until
      // someone reads a labour report weeks later.
      await this.segments.endAllForOrder(
        { serviceOrderId: id, endReason: 'PAUSED', actorUserId: userId },
        tx as never,
      );

      return so;
    });

    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: id,
      fromStatus: order.status,
      toStatus: 'PAUSED',
      changedByUserId: userId,
      reasonCode: dto.reasonCode,
      notes: dto.notes,
    });

    // Recording-only scope: do NOT sync ServiceVisit status and do NOT recompute
    // the queue — a pause must not affect rank/ETA (deferred to a follow-up CR).
    this.logger.log(`ServiceOrder ${id} paused (${dto.reasonCode}) by ${userId}`);
    return updated;
  }

  async resume(id: string, dto: ResumeServiceOrderDto, userId: string) {
    const order = await this.findById(id);
    if (order.status !== 'PAUSED') {
      throw new BadRequestException(
        `Cannot resume a service order in status ${order.status} — must be PAUSED`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const so = await tx.serviceOrder.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
      // Close the open pause interval — there should be exactly one.
      await tx.serviceOrderPause.updateMany({
        where: { serviceOrderId: id, endedAt: null },
        data: { endedAt: new Date(), resumedByUserId: userId },
      });

      // CR-2026-090 — the labour clock restarts for everyone still assigned. Anyone
      // taken off the job while it sat paused is deliberately not reopened.
      await this.segments.resumeForOrder(
        { serviceOrderId: id, actorUserId: userId },
        tx as never,
      );

      return so;
    });

    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: id,
      fromStatus: 'PAUSED',
      toStatus: 'IN_PROGRESS',
      changedByUserId: userId,
      reasonCode: 'RESUME',
      notes: dto.notes,
    });

    // The visit was never changed on pause, so there is nothing to re-sync and no recompute.
    this.logger.log(`ServiceOrder ${id} resumed by ${userId}`);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // REWORK / RECTIFY  (CR-2026-001) — QC failure re-opens work, preserving history
  // ---------------------------------------------------------------------------

  async openRework(id: string, dto: ReworkServiceOrderDto, userId: string) {
    const order = await this.findById(id);
    if (order.status !== 'QC') {
      throw new BadRequestException(
        `Cannot open rework on a service order in status ${order.status} — must be QC`,
      );
    }

    const priorCount = await this.prisma.serviceOrderRework.count({
      where: { serviceOrderId: id },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const so = await tx.serviceOrder.update({
        where: { id },
        // Re-opening: clear completedAt (set on entry to QC) and startedAt, so the
        // next technician's elapsed/working clocks time THIS attempt rather than
        // carrying the failed one's hours.
        data: { status: 'APPROVED', completedAt: null, startedAt: null },
      });
      await tx.serviceOrderRework.create({
        data: {
          serviceOrderId: id,
          reasonCode: dto.reasonCode,
          description: dto.description,
          reworkCount: priorCount + 1,
          openedByUserId: userId,
        },
      });
      // Defensive: entry to QC already ends the assignment, but never leave an open
      // one attached to an order that is going back out for assignment.
      await tx.technicianAssignment.updateMany({
        where: { serviceOrderId: id, endedAt: null },
        data: { endedAt: new Date(), status: 'COMPLETED' },
      });
      return so;
    });

    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: id,
      fromStatus: 'QC',
      toStatus: 'APPROVED',
      changedByUserId: userId,
      reasonCode: `REWORK:${dto.reasonCode}`,
      notes: dto.description,
    });

    // The car is back in the shop's queue awaiting assignment — not in service.
    await this.prisma.serviceVisit.update({
      where: { id: order.serviceVisitId },
      data: { status: 'QUEUED' as any },
    });
    await this.statusHistory.record({
      entityType: 'ServiceVisit',
      entityId: order.serviceVisitId,
      fromStatus: order.serviceVisit.status,
      toStatus: 'QUEUED',
      changedByUserId: userId,
      reasonCode: 'REWORK_REOPEN',
      notes: `ServiceOrder ${id} failed QC and needs reassignment`,
    });

    // Put the ticket back in the waiting line so the recompute ranks it again.
    await this.syncQueueTicket(order.serviceVisitId, 'APPROVED' as ServiceOrderStatus);
    await this.triggerQueueRecompute(order.serviceVisit.siteId);

    this.logger.log(
      `ServiceOrder ${id} sent to rework (#${priorCount + 1}, ${dto.reasonCode}) by ${userId}`,
    );
    return updated;
  }

  // ---------------------------------------------------------------------------
  // MULTI-TECH ASSIGNMENT MANAGEMENT
  // ---------------------------------------------------------------------------

  async assignAdditional(orderId: string, technicianId: string, bayId?: string, resourceId?: string, userId?: string) {
    const order = await this.findById(orderId);
    if (!['APPROVED', 'ASSIGNED', 'IN_PROGRESS'].includes(order.status)) {
      throw new BadRequestException(`Cannot add technician to order in status ${order.status}`);
    }

    // Double-booking check — allow the same tech on other orders of the SAME visit (CR-2026-068).
    const active = await this.prisma.technicianAssignment.findFirst({
      where: {
        technicianId,
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        endedAt: null,
        serviceOrder: { serviceVisitId: { not: order.serviceVisitId } },
      },
    });
    if (active) {
      throw new BadRequestException(`Technician already has an active assignment on another visit (${active.id})`);
    }

    const assignment = await this.prisma.technicianAssignment.create({
      data: {
        serviceOrderId: orderId,
        technicianId,
        bayId: bayId ?? null,
        resourceId: resourceId ?? null,
        isPrimary: false,
        status: 'ASSIGNED',
      },
    });

    await this.auditService.log({
      actorUserId: userId ?? 'SYSTEM',
      action: 'ASSIGNMENT_ADD_HELPER',
      entityType: 'TechnicianAssignment',
      entityId: assignment.id,
      afterJson: { serviceOrderId: orderId, technicianId, isPrimary: false },
    });

    return assignment;
  }

  async removeAssignment(orderId: string, assignmentId: string, userId: string) {
    const assignment = await this.prisma.technicianAssignment.findFirst({
      where: { id: assignmentId, serviceOrderId: orderId },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found on order ${orderId}`);
    }

    // CR-2026-090 — taking someone off a live job closes their labour segment. Their
    // time up to this point is kept: they did the work, whatever happened next.
    await this.segments.endSegment({
      serviceOrderId: orderId,
      technicianId: assignment.technicianId,
      endReason: 'REASSIGNED',
      actorUserId: userId,
    });

    await this.prisma.technicianAssignment.update({
      where: { id: assignmentId },
      data: { endedAt: new Date(), status: 'REMOVED' },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'ASSIGNMENT_REMOVED',
      entityType: 'TechnicianAssignment',
      entityId: assignmentId,
      beforeJson: { technicianId: assignment.technicianId, isPrimary: assignment.isPrimary },
    });

    return { removed: true };
  }

  async updateAssignment(orderId: string, assignmentId: string, data: { technicianId?: string; isPrimary?: boolean; bayId?: string }, userId: string) {
    const assignment = await this.prisma.technicianAssignment.findFirst({
      where: { id: assignmentId, serviceOrderId: orderId },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found on order ${orderId}`);
    }

    // CR-2026-068 — an assignment can be edited only before the mechanic starts work.
    if (assignment.status !== 'ASSIGNED') {
      throw new BadRequestException(
        'Cannot edit this assignment — work has already started.',
      );
    }

    const updateData: any = {};
    if (data.technicianId) updateData.technicianId = data.technicianId;
    if (data.bayId !== undefined) updateData.bayId = data.bayId || null;

    // If setting isPrimary=true, clear isPrimary on all other assignments for this order
    if (data.isPrimary === true) {
      await this.prisma.technicianAssignment.updateMany({
        where: { serviceOrderId: orderId, id: { not: assignmentId } },
        data: { isPrimary: false },
      });
      updateData.isPrimary = true;
    } else if (data.isPrimary === false) {
      updateData.isPrimary = false;
    }

    const updated = await this.prisma.technicianAssignment.update({
      where: { id: assignmentId },
      data: updateData,
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'ASSIGNMENT_UPDATED',
      entityType: 'TechnicianAssignment',
      entityId: assignmentId,
      beforeJson: { technicianId: assignment.technicianId, isPrimary: assignment.isPrimary },
      afterJson: updateData,
    });

    return updated;
  }

  async startAssignment(orderId: string, assignmentId: string, userId: string) {
    const assignment = await this.prisma.technicianAssignment.findFirst({
      where: { id: assignmentId, serviceOrderId: orderId },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found`);
    }

    // CR-2026-069 — the mechanic starts their own work, not the front desk / manager.
    const tech = await this.prisma.technician.findUnique({
      where: { userAccountId: userId },
    });
    if (!tech || tech.id !== assignment.technicianId) {
      throw new ForbiddenException(
        'Only the assigned technician can start this work.',
      );
    }

    // CR-2026-088 — KPI-tracked work needs a confirmed Sedan/SUV class, because the
    // class picks the standard the job will be measured against. Asking at the point
    // of starting is the last honest moment: afterwards the clock is already running
    // and any classification looks like it was chosen to suit the result.
    await this.kpi.assertVehicleClassConfirmed(orderId);

    // CR-2026-092 — a conditional service with no qualifier cannot be benchmarked, and
    // the last honest moment to ask is now. Discovering it at submit-to-QC leaves a
    // technician who did the work with a job that cannot be rated, over a question
    // nobody put to them.
    //
    // Deliberately actionable rather than blocking-with-no-way-out: the message names
    // the service and the missing answer, and a service advisor or manager can supply
    // it immediately from the work-order screen.
    const readiness = await this.getBenchmarkReadiness(orderId);
    if (readiness.missingQualifiers.length > 0) {
      throw new BadRequestException(
        readiness.missingQualifiers.map((m) => m.message).join(' ') +
          ' A service advisor can set this on the work order.',
      );
    }

    const updated = await this.prisma.technicianAssignment.update({
      where: { id: assignmentId },
      data: { startedAt: new Date(), status: 'IN_PROGRESS' },
    });

    // CR-2026-090 — open this technician's labour segment.
    //
    // Not wrapped in a try/catch like the KPI snapshot below. The snapshot is
    // reporting derived from timestamps that exist anyway, so it can fail without
    // losing information; a segment IS the record of when this person started, and
    // there is no way to reconstruct it afterwards. If it cannot be written, the
    // start should fail loudly rather than silently produce a technician who worked
    // on a job with no evidence of having done so.
    await this.segments.startSegment({
      serviceOrderId: orderId,
      assignmentId,
      technicianId: assignment.technicianId,
      role: assignment.isPrimary ? 'PRIMARY' : 'ASSISTING',
      startSource: 'TECHNICIAN_START',
      actorUserId: userId,
    });

    // If this is the first started assignment and order is ASSIGNED, transition to IN_PROGRESS
    const order = await this.prisma.serviceOrder.findUnique({ where: { id: orderId } });
    if (order && order.status === 'ASSIGNED') {
      await this.changeStatus(orderId, { toStatus: 'IN_PROGRESS' as any }, userId);
    }

    // CR-2026-088 — fix the terms the job will be judged on NOW, before the outcome
    // is known. A benchmark chosen after seeing a poor result is not a benchmark.
    // Wrapped: a reporting problem must never stop someone starting work.
    try {
      await this.kpi.openSnapshotOnStart(orderId);
    } catch (err) {
      this.logger.error(
        `KPI snapshot could not be opened for order ${orderId}: ${(err as Error).message}`,
      );
    }

    return updated;
  }

  async endAssignment(orderId: string, assignmentId: string, userId: string) {
    const assignment = await this.prisma.technicianAssignment.findFirst({
      where: { id: assignmentId, serviceOrderId: orderId },
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found`);
    }

    // CR-2026-090 — an assistant stepping off the job closes their labour segment.
    // Everyone else on the order keeps working, so only this technician's segment ends.
    await this.segments.endSegment({
      serviceOrderId: orderId,
      technicianId: assignment.technicianId,
      endReason: 'ASSISTANCE_COMPLETE',
      actorUserId: userId,
    });

    const updated = await this.prisma.technicianAssignment.update({
      where: { id: assignmentId },
      data: { endedAt: new Date(), status: 'COMPLETED' },
    });

    return updated;
  }

  /**
   * CR-2026-073 — timing for a technician's live job: start time, completion (if any),
   * and total paused milliseconds (+ the open pause start if currently paused) so the
   * client can show elapsed time AND actual working time (elapsed − paused).
   */
  async getWorkTiming(orderId: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: orderId },
      select: { startedAt: true, completedAt: true, status: true },
    });
    if (!order) throw new NotFoundException(`ServiceOrder ${orderId} not found`);

    const pauses = await this.prisma.serviceOrderPause.findMany({
      where: { serviceOrderId: orderId },
      select: { startedAt: true, endedAt: true },
    });

    let pausedMs = 0;
    let openPauseStartedAt: Date | null = null;
    for (const p of pauses) {
      if (p.endedAt) pausedMs += p.endedAt.getTime() - p.startedAt.getTime();
      else openPauseStartedAt = p.startedAt;
    }

    return {
      startedAt: order.startedAt,
      completedAt: order.completedAt,
      status: order.status,
      pausedMs,
      openPauseStartedAt,
    };
  }

  /**
   * CR-2026-073 — the assigned technician finishes their work and hands it to QC.
   * Verifies the caller is a technician assigned to this order, transitions
   * IN_PROGRESS → QC (via changeStatus, which stamps completedAt + syncs the visit +
   * recomputes), and ends the technician's active assignment(s) on the order. The
   * resulting QC state surfaces to managers as a "ready for QC" alert (CR-2026-074).
   */
  async readyForQc(orderId: string, userId: string) {
    const order = await this.findById(orderId);
    if (order.status !== 'IN_PROGRESS') {
      throw new BadRequestException(
        `Cannot send to QC from status ${order.status} — resume the work first if paused.`,
      );
    }

    const tech = await this.prisma.technician.findUnique({
      where: { userAccountId: userId },
    });
    const isAssignedTech =
      !!tech && order.assignments.some((a) => a.technicianId === tech.id && a.endedAt === null);
    if (!isAssignedTech) {
      throw new ForbiddenException('Only the assigned technician can send this work to QC.');
    }

    await this.changeStatus(orderId, { toStatus: 'QC' as any }, userId);

    // CR-2026-090 — close every open labour segment at the same moment the
    // assignments end. Submitting to QC stops the work for everyone, including any
    // assistant who never pressed anything themselves.
    await this.segments.endAllForOrder({
      serviceOrderId: orderId,
      endReason: 'SUBMITTED_TO_QC',
      actorUserId: userId,
    });

    await this.prisma.technicianAssignment.updateMany({
      where: { serviceOrderId: orderId, endedAt: null },
      data: { endedAt: new Date(), status: 'COMPLETED' },
    });

    // CR-2026-075 — work is done: free the dispatch-board bay (ResourceOccupancy) so it
    // doesn't linger OCCUPIED through QC. Mirrors the old completeTicket behaviour. The
    // changeStatus(QC) above already recomputes → the dispatch board refetches and shows
    // the bay available. Only frees if no OTHER active order on the visit still holds it.
    const otherActive = await this.prisma.serviceOrder.count({
      where: {
        serviceVisitId: order.serviceVisitId,
        id: { not: orderId },
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'] },
      },
    });
    if (otherActive === 0) {
      await this.prisma.resourceOccupancy.updateMany({
        where: { serviceVisitId: order.serviceVisitId, status: 'OCCUPIED' },
        data: { status: 'AVAILABLE', serviceVisitId: null, technicianId: null },
      });
    }

    // CR-2026-088 — freeze the KPI result NOW, at the first submission to QC.
    //
    // This cannot be derived on demand later: a failed QC sends the order back to
    // APPROVED and nulls startedAt/completedAt so the next attempt times only
    // itself. Without a snapshot taken here, reworking a job would quietly erase
    // the first attempt's completion result — which is precisely the number the
    // manager wants preserved when quality fails.
    //
    // Never allowed to break the technician's action: a KPI failure is a reporting
    // problem, not a reason to reject work that is genuinely finished.
    try {
      await this.kpi.captureSnapshotOnQc(orderId);
    } catch (err) {
      this.logger.error(
        `KPI snapshot failed for order ${orderId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }

    this.logger.log(`ServiceOrder ${orderId} sent to QC by technician (${userId})`);
    return this.findById(orderId);
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Resolve service type codes to their database records.
   * Throws if any code is not found or not active.
   */
  private async resolveServiceTypeCodes(
    codes: string[],
  ): Promise<
    Map<string, { id: string; baseDurationMinutes: number }>
  > {
    const uniqueCodes = [...new Set(codes)];

    const serviceTypes = await this.prisma.serviceType.findMany({
      where: { code: { in: uniqueCodes }, isActive: true },
      select: { id: true, code: true, baseDurationMinutes: true },
    });

    const map = new Map(
      serviceTypes.map((st) => [
        st.code,
        { id: st.id, baseDurationMinutes: st.baseDurationMinutes },
      ]),
    );

    const missing = uniqueCodes.filter((c) => !map.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown or inactive service type codes: ${missing.join(', ')}`,
      );
    }

    return map;
  }

  /**
   * Trigger a queue recompute for the given site.
   * Failures are logged but do not block the calling operation.
   */
  /**
   * CR-2026-084 — mirror a ServiceOrder transition onto the visit's queue ticket.
   *
   * Called before the recompute so the ticket is already in its new state when the
   * scheduler runs. A ticket entering IN_SERVICE also surrenders its queue position:
   * the car is no longer waiting, and leaving a stale rank behind made it collide
   * with the positions handed to the tickets still in line.
   */
  /**
   * CR-2026-087 — a technician may not pass the quality check on work they did.
   *
   * A quality check exists to get a second pair of eyes on the job; letting the
   * person who built it sign it off makes the control ceremonial. Managers and
   * advisors are unaffected — they hold no technician record, so they fall
   * straight through.
   *
   * This checks ALL assignments on the order, not just open ones: entry to QC ends
   * the technician's assignment, so by the time anyone can pass the check their
   * assignment is already closed.
   */
  private async assertQcNotSelfApproved(
    serviceOrderId: string,
    userId: string,
  ): Promise<void> {
    const tech = await this.prisma.technician.findUnique({
      where: { userAccountId: userId },
      select: { id: true },
    });
    if (!tech) return; // Not a technician (manager / advisor) — nothing to guard.

    const ownWork = await this.prisma.technicianAssignment.findFirst({
      where: { serviceOrderId, technicianId: tech.id },
      select: { id: true },
    });
    if (ownWork) {
      throw new ForbiddenException(
        'You cannot pass the quality check on work you carried out. ' +
          'A different technician, or a manager, must check this job.',
      );
    }
  }

  private async syncQueueTicket(
    serviceVisitId: string,
    toStatus: ServiceOrderStatus,
  ): Promise<void> {
    const target = ORDER_TO_TICKET_STATUS[toStatus];
    if (!target) return;

    const ticket = await this.prisma.queueTicket.findUnique({
      where: { serviceVisitId },
      select: { id: true, displayStatus: true },
    });
    // Never resurrect a ticket that has already been closed out or cancelled.
    if (!ticket || ['COMPLETED', 'CANCELLED'].includes(ticket.displayStatus)) return;
    if (ticket.displayStatus === target) return;

    await this.prisma.queueTicket.update({
      where: { id: ticket.id },
      data: {
        displayStatus: target as any,
        // Out of the waiting line while in service; re-ranked by the next recompute
        // when it goes back to WAITING.
        ...(target === 'IN_SERVICE' ? { queueRank: null, readyForDispatch: false } : {}),
      },
    });

    this.logger.log(
      `QueueTicket ${ticket.id} display status ${ticket.displayStatus} -> ${target} (order ${toStatus})`,
    );
  }

  private async triggerQueueRecompute(siteId: string): Promise<void> {
    try {
      await this.schedulingService.recomputeQueue(siteId);
    } catch (err) {
      this.logger.error(
        `Queue recompute failed for site ${siteId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
