import {
  Injectable,
  BadRequestException,
  ConflictException,
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
import { PauseReason, ServiceOrderStatus, WorkBay } from '@prisma/client';

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

// CR-2026-098b — the visit status derives from ALL of the visit's orders, not
// from whichever order transitioned last. With one job waiting on parts and
// another passing QC, last-write-wins drove the visit to READY_FOR_PICKUP —
// telling the customer the car was ready while work sat blocked. Priority:
// active work > parts block > quality check > ready. A single-order visit
// reduces exactly to the old per-transition mapping (no behaviour change).
function deriveVisitStatus(orderStatuses: ServiceOrderStatus[]): string | null {
  const live = orderStatuses.filter((s) => s !== 'CANCELLED');
  if (live.length === 0) return null;
  if (live.some((s) => s === 'IN_PROGRESS')) return 'IN_SERVICE';
  if (live.some((s) => s === 'WAITING_PARTS')) return 'WAITING_PARTS';
  // PAUSED / WAITING_CUSTOMER carry no visit-level state of their own: the car
  // is still in the service flow; the order badge carries the detail.
  if (live.some((s) => s === 'PAUSED' || s === 'WAITING_CUSTOMER')) return 'IN_SERVICE';
  if (live.some((s) => s === 'QC')) return 'QC';
  if (live.every((s) => s === 'READY_TO_INVOICE' || s === 'CLOSED')) return 'READY_FOR_PICKUP';
  // Only DRAFT/APPROVED/ASSIGNED remain — the queue owns the visit status.
  return null;
}

// Order statuses whose transitions should re-derive the visit status.
const VISIT_SYNC_TRIGGERS = new Set<ServiceOrderStatus>([
  'IN_PROGRESS', 'WAITING_PARTS', 'WAITING_CUSTOMER', 'PAUSED', 'QC', 'READY_TO_INVOICE', 'CANCELLED',
] as ServiceOrderStatus[]);

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
// CR-2026-098b — like the visit status, the ticket's display status derives from
// ALL orders: a rework sending ONE job back to APPROVED must not put a car that
// is still actively being worked back into the waiting line.
const WORKING_ORDER_STATUSES = new Set<ServiceOrderStatus>([
  'IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER', 'QC', 'READY_TO_INVOICE',
] as ServiceOrderStatus[]);

function deriveTicketStatus(orderStatuses: ServiceOrderStatus[]): string | null {
  const live = orderStatuses.filter((s) => s !== 'CANCELLED' && s !== 'CLOSED');
  if (live.some((s) => WORKING_ORDER_STATUSES.has(s))) return 'IN_SERVICE';
  if (live.some((s) => s === 'APPROVED' || s === 'ASSIGNED')) return 'WAITING';
  return null;
}

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

    // 3. Workload check (CR-2026-100 — a warning, not a wall). A technician can
    //    legitimately hold several jobs: one waiting on parts, one on customer
    //    authorisation, one active. Assigning MORE work while they already hold
    //    open work on other visits is an advisor/manager judgement call, so the
    //    first attempt returns the workload for review and `acknowledgeWorkload`
    //    proceeds — audited. Checked BEFORE bay resolution: the workload question
    //    is about the technician, and it should reach the advisor first, not hide
    //    behind a bay-availability error. (Multiple orders on the SAME visit
    //    remain one job, CR-2026-068, and never trip this.)
    await this.assertWorkloadAcknowledged(
      dto.technicianId,
      order.serviceVisitId,
      dto.acknowledgeWorkload === true,
      userId,
    );

    // 4. Resolve the bay: use the one provided, else auto-assign the first
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
  async assignAllForVisit(visitId: string, technicianId: string, userId: string, acknowledgeWorkload?: boolean) {
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
      updated.push(
        await this.assign(o.id, { technicianId, acknowledgeWorkload } as AssignTechnicianDto, userId),
      );
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
  /**
   * CR-2026-100 — ALL of the technician's current work, in one authoritative call.
   *
   * A job that goes Waiting-for-Parts used to vanish from this list (the default
   * statuses stopped at PAUSED) — the exact opposite of what a multi-job workload
   * needs. Now: every open assignment in any live order state, plus work handed
   * to QC or completed today, each row carrying what the floor screen needs —
   * vehicle class, visit number, priority, this technician's own labour time,
   * pause state (including a pending acknowledgement), and whether THIS job is
   * the one currently on the clock (`hasOpenSegment`).
   */
  async getMyAssignments(userId: string, status?: string) {
    const tech = await this.prisma.technician.findUnique({
      where: { userAccountId: userId },
    });
    if (!tech) return [];

    const openStatuses = status
      ? [status as ServiceOrderStatus]
      : (['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'] as ServiceOrderStatus[]);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const assignments = await this.prisma.technicianAssignment.findMany({
      where: {
        technicianId: tech.id,
        OR: [
          // Live workload: still-open assignments on live orders.
          { endedAt: null, serviceOrder: { status: { in: openStatuses } } },
          // Today's finished work: submitted to QC / completed — visible, read-only.
          {
            endedAt: { gte: todayStart },
            status: 'COMPLETED',
            serviceOrder: { status: { in: ['QC', 'READY_TO_INVOICE', 'CLOSED'] } },
          },
        ],
      },
      include: {
        bay: { select: { code: true } },
        workSegments: { select: { startedAt: true, endedAt: true } },
        serviceOrder: {
          include: {
            items: { include: { serviceType: { select: { name: true } } } },
            pauses: {
              select: {
                id: true,
                reasonCode: true,
                notes: true,
                startedAt: true,
                endedAt: true,
                approvalStatus: true,
                enteredOnBehalf: true,
              },
            },
            serviceVisit: {
              include: {
                customer: { select: { firstName: true, lastName: true } },
                vehicle: {
                  select: { plateNumber: true, make: true, model: true, serviceClass: true },
                },
                queueTicket: { select: { id: true, ticketNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'asc' },
    });

    const now = Date.now();
    return assignments.map((a) => {
      const order = a.serviceOrder;
      const visit = order.serviceVisit;

      let pausedMs = 0;
      let openPause: (typeof order.pauses)[number] | null = null;
      for (const p of order.pauses) {
        if (p.endedAt) pausedMs += p.endedAt.getTime() - p.startedAt.getTime();
        else openPause = p;
      }

      // This technician's own labour on this job — the sum of their segments,
      // never the wall clock.
      const myWorkMs = a.workSegments.reduce(
        (sum, s) => sum + ((s.endedAt?.getTime() ?? now) - s.startedAt.getTime()),
        0,
      );

      return {
        assignmentId: a.id,
        orderId: a.serviceOrderId,
        orderStatus: order.status,
        assignmentStatus: a.status,
        assignmentEndedAt: a.endedAt,
        startedAt: order.startedAt,
        completedAt: order.completedAt,
        serviceVisitId: order.serviceVisitId,
        visitNumber: visit.visitNumber ?? null,
        queueTicketId: visit.queueTicket?.id ?? null,
        ticketNumber: visit.queueTicket?.ticketNumber ?? null,
        customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
        vehicle:
          [visit.vehicle.make, visit.vehicle.model].filter(Boolean).join(' ') ||
          visit.vehicle.plateNumber,
        plate: visit.vehicle.plateNumber,
        vehicleClass: visit.vehicle.serviceClass ?? null,
        priorityClass: (visit as { queuePriorityClass?: string | null }).queuePriorityClass ?? null,
        bay: a.bay?.code ?? null,
        services: order.items.map((i) => i.serviceType.name),
        pausedMs,
        myWorkMs,
        hasOpenSegment: a.workSegments.some((s) => !s.endedAt),
        openPause: openPause
          ? {
              id: openPause.id,
              reasonCode: openPause.reasonCode,
              notes: openPause.notes,
              startedAt: openPause.startedAt,
              approvalStatus: openPause.approvalStatus,
              enteredOnBehalf: openPause.enteredOnBehalf,
            }
          : null,
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
      // CR-2026-098 — an open pause/waiting interval on a cancelled job must also
      // close, or its "paused time" keeps growing forever against a job nobody is
      // doing (the same failure mode the labour clock had).
      await this.prisma.serviceOrderPause.updateMany({
        where: { serviceOrderId: id, endedAt: null },
        data: { endedAt: new Date(), resumedByUserId: userId },
      });
    }

    // CR-2026-098 — WAITING_PARTS / WAITING_CUSTOMER are measured delays, not just
    // states: entering one opens an interval in the pause ledger (and stops the
    // labour clock); leaving one closes it (and restarts labour for everyone still
    // assigned). This is what the Waiting-for-Parts metric and every duration
    // calculation read from — the operational state itself, not an approximation.
    if (toStatus === 'WAITING_PARTS' || toStatus === 'WAITING_CUSTOMER') {
      // CR-2026-100 — the ledger row records whose labour stopped, whether it was
      // entered on the technician's behalf, and whether it still needs an
      // advisor/manager acknowledgement. The interval itself starts NOW — the
      // moment it was reported — regardless of when anyone reviews it.
      const attribution = await this.derivePauseAttribution(id, userId);
      const pauseRow = await this.prisma.serviceOrderPause.create({
        data: {
          serviceOrderId: id,
          reasonCode: toStatus === 'WAITING_PARTS' ? 'WAITING_PARTS' : 'CUSTOMER_AUTHORIZATION',
          pausedByUserId: userId,
          notes: dto.notes,
          ...attribution,
        },
      });
      if (attribution.enteredOnBehalf) {
        await this.auditService.log({
          actorUserId: userId,
          action: 'PAUSE_RECORDED_ON_BEHALF',
          entityType: 'ServiceOrderPause',
          entityId: pauseRow.id,
          afterJson: {
            reasonCode: pauseRow.reasonCode,
            technicianId: attribution.technicianId,
          },
          notes: dto.notes,
        });
      }
      await this.segments.endAllForOrder({
        serviceOrderId: id,
        endReason: 'PAUSED',
        actorUserId: userId,
      });
    }
    if (
      (fromStatus === 'WAITING_PARTS' || fromStatus === 'WAITING_CUSTOMER') &&
      toStatus === 'IN_PROGRESS'
    ) {
      await this.prisma.serviceOrderPause.updateMany({
        where: { serviceOrderId: id, endedAt: null },
        data: { endedAt: new Date(), resumedByUserId: userId },
      });
      await this.segments.resumeForOrder({ serviceOrderId: id, actorUserId: userId });
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

    // Update the ServiceVisit status from the AGGREGATE of all its orders.
    if (VISIT_SYNC_TRIGGERS.has(toStatus)) {
      const siblingOrders = await this.prisma.serviceOrder.findMany({
        where: { serviceVisitId: order.serviceVisitId },
        select: { status: true },
      });
      const visitStatus = deriveVisitStatus(siblingOrders.map((o) => o.status));
      if (visitStatus && visitStatus !== order.serviceVisit.status) {
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
          notes: `Derived from all orders after ServiceOrder ${id} → ${toStatus}`,
        });
      }
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
    // CR-2026-098 — "Waiting for parts" in the pause menu IS the WAITING_PARTS
    // state. One gesture for the technician; the correct first-class status (with
    // its scheduling semantics, visit/queue sync, and measured interval) underneath.
    // Never PAUSED-with-a-reason, which the parts views would not see.
    //
    // CR-2026-098b — CUSTOMER_AUTHORIZATION is unified the same way: picking
    // "Waiting for authorization" lands the order in the first-class
    // WAITING_CUSTOMER state. Before this, the same operational condition lived
    // in two places (a PAUSED reason and a status), and a ledger row reading
    // CUSTOMER_AUTHORIZATION could have meant either. Now: the STATUS is always
    // WAITING_CUSTOMER, and a CUSTOMER_AUTHORIZATION ledger row is always its
    // measured interval — one condition, one representation.
    if (dto.reasonCode === 'WAITING_PARTS' || dto.reasonCode === 'CUSTOMER_AUTHORIZATION') {
      const toStatus = dto.reasonCode === 'WAITING_PARTS' ? 'WAITING_PARTS' : 'WAITING_CUSTOMER';
      return this.changeStatus(
        id,
        { toStatus, reasonCode: dto.reasonCode, notes: dto.notes },
        userId,
      );
    }

    const order = await this.findById(id);
    if (!(VALID_TRANSITIONS[order.status] ?? []).includes('PAUSED' as ServiceOrderStatus)) {
      throw new BadRequestException(
        `Cannot pause a service order in status ${order.status} — must be IN_PROGRESS`,
      );
    }

    // CR-2026-100 — who this pause belongs to and whether it needs acknowledgement.
    const attribution = await this.derivePauseAttribution(id, userId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const so = await tx.serviceOrder.update({ where: { id }, data: { status: 'PAUSED' } });
      await tx.serviceOrderPause.create({
        data: {
          serviceOrderId: id,
          reasonCode: dto.reasonCode,
          pausedByUserId: userId,
          notes: dto.notes,
          ...attribution,
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

    // CR-2026-100 — an advisor/manager recording the stop for the technician is a
    // distinct fact from the technician pressing the button, and reads that way.
    if (attribution.enteredOnBehalf) {
      await this.auditService.log({
        actorUserId: userId,
        action: 'PAUSE_RECORDED_ON_BEHALF',
        entityType: 'ServiceOrder',
        entityId: id,
        afterJson: { reasonCode: dto.reasonCode, technicianId: attribution.technicianId },
        notes: dto.notes,
      });
    }

    // Recording-only scope: do NOT sync ServiceVisit status and do NOT recompute
    // the queue — a pause must not affect rank/ETA (deferred to a follow-up CR).
    this.logger.log(`ServiceOrder ${id} paused (${dto.reasonCode}) by ${userId}`);
    return updated;
  }

  async resume(id: string, dto: ResumeServiceOrderDto, userId: string) {
    const order = await this.findById(id);

    // CR-2026-098 — one Resume gesture regardless of how work stopped. A job
    // waiting on parts or on the customer resumes through the status machine,
    // which closes the measured interval and restarts the labour clock.
    if (order.status === 'WAITING_PARTS' || order.status === 'WAITING_CUSTOMER') {
      return this.changeStatus(
        id,
        { toStatus: 'IN_PROGRESS', reasonCode: 'RESUME', notes: dto.notes },
        userId,
      );
    }

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
  // PAUSE ACKNOWLEDGEMENT WORKFLOW (CR-2026-100)
  //
  // A technician-reported pause takes effect the moment it is reported — the
  // labour clock stops at the technician's timestamp, never at whenever an
  // advisor happens to open the application. The advisor/manager then
  // acknowledges (approves) or rejects it. Approval never moves the clock;
  // rejection needs a reason, resumes the work, and keeps the original request.
  // ---------------------------------------------------------------------------

  /**
   * Who does this pause belong to, and does it need acknowledgement?
   *
   *  - The assigned technician pausing their own job → PENDING acknowledgement.
   *  - An advisor/manager recording it (on the technician's behalf) → APPROVED
   *    immediately: they ARE the acknowledger, and the history says who entered it.
   *  - A technician recording it for a job they are not assigned to → on-behalf,
   *    but still PENDING: an advisor has to see it.
   */
  private async derivePauseAttribution(orderId: string, actorUserId: string) {
    const [actorTech, openAssignments] = await Promise.all([
      this.prisma.technician.findUnique({
        where: { userAccountId: actorUserId },
        select: { id: true },
      }),
      this.prisma.technicianAssignment.findMany({
        where: { serviceOrderId: orderId, endedAt: null },
        select: { technicianId: true, isPrimary: true },
      }),
    ]);

    const isAssignedTech =
      !!actorTech && openAssignments.some((a) => a.technicianId === actorTech.id);
    const technicianId = isAssignedTech
      ? actorTech!.id
      : (openAssignments.find((a) => a.isPrimary)?.technicianId ??
        openAssignments[0]?.technicianId ??
        null);
    const isStaffActor = !actorTech;

    return {
      technicianId,
      enteredOnBehalf: !isAssignedTech,
      approvalStatus: (isStaffActor ? 'APPROVED' : 'PENDING') as 'APPROVED' | 'PENDING',
      reviewedByUserId: isStaffActor ? actorUserId : null,
      reviewedAt: isStaffActor ? new Date() : null,
    };
  }

  /**
   * Pause requests awaiting advisor/manager acknowledgement — the open, pending
   * rows only. A pause that ended before anyone reviewed it drops off this list
   * (there is nothing left to act on) but stays PENDING in the job's history.
   */
  async listPendingPauseApprovals(siteId?: string) {
    const rows = await this.prisma.serviceOrderPause.findMany({
      where: {
        approvalStatus: 'PENDING',
        endedAt: null,
        ...(siteId ? { serviceOrder: { serviceVisit: { siteId } } } : {}),
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
                visitNumber: true,
                customer: { select: { firstName: true, lastName: true } },
                vehicle: { select: { plateNumber: true, make: true, model: true } },
                queueTicket: { select: { id: true, ticketNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { startedAt: 'asc' },
    });

    const techIds = [...new Set(rows.map((r) => r.technicianId).filter(Boolean))] as string[];
    const techs = techIds.length
      ? await this.prisma.technician.findMany({
          where: { id: { in: techIds } },
          select: { id: true, employeeCode: true, userAccount: { select: { fullName: true } } },
        })
      : [];
    const techById = new Map(techs.map((t) => [t.id, t]));

    const now = Date.now();
    return rows.map((r) => {
      const visit = r.serviceOrder.serviceVisit;
      const tech = r.technicianId ? techById.get(r.technicianId) : undefined;
      return {
        pauseId: r.id,
        orderId: r.serviceOrder.id,
        orderStatus: r.serviceOrder.status,
        serviceVisitId: visit.id,
        visitNumber: visit.visitNumber ?? null,
        queueTicketId: visit.queueTicket?.id ?? null,
        ticketNumber: visit.queueTicket?.ticketNumber ?? null,
        customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
        vehicle:
          [visit.vehicle.make, visit.vehicle.model].filter(Boolean).join(' ') ||
          visit.vehicle.plateNumber,
        plate: visit.vehicle.plateNumber,
        services: r.serviceOrder.items.map((i) => i.serviceType.name),
        technicianName: tech?.userAccount?.fullName ?? null,
        technicianCode: tech?.employeeCode ?? null,
        reasonCode: r.reasonCode,
        notes: r.notes,
        requestedAt: r.startedAt,
        enteredOnBehalf: r.enteredOnBehalf,
        waitingMinutes: Math.floor((now - r.startedAt.getTime()) / 60000),
      };
    });
  }

  /** Full pause history for one order — the shared story every role reads (CR-2026-100). */
  async listPauses(orderId: string) {
    await this.findById(orderId); // 404 on unknown order
    const rows = await this.prisma.serviceOrderPause.findMany({
      where: { serviceOrderId: orderId },
      orderBy: { startedAt: 'asc' },
    });

    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.pausedByUserId, r.resumedByUserId, r.reviewedByUserId, r.correctedByUserId])
          .filter(Boolean),
      ),
    ] as string[];
    const techIds = [...new Set(rows.map((r) => r.technicianId).filter(Boolean))] as string[];
    const [users, techs] = await Promise.all([
      userIds.length
        ? this.prisma.userAccount.findMany({
            where: { id: { in: userIds } },
            select: { id: true, fullName: true },
          })
        : [],
      techIds.length
        ? this.prisma.technician.findMany({
            where: { id: { in: techIds } },
            select: { id: true, userAccount: { select: { fullName: true } } },
          })
        : [],
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));
    const techNameById = new Map(techs.map((t) => [t.id, t.userAccount?.fullName ?? null]));

    return rows.map((r) => ({
      id: r.id,
      reasonCode: r.reasonCode,
      notes: r.notes,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      technicianName: r.technicianId ? (techNameById.get(r.technicianId) ?? null) : null,
      recordedByName: r.pausedByUserId ? (nameById.get(r.pausedByUserId) ?? null) : null,
      resumedByName: r.resumedByUserId ? (nameById.get(r.resumedByUserId) ?? null) : null,
      enteredOnBehalf: r.enteredOnBehalf,
      approvalStatus: r.approvalStatus,
      reviewedByName: r.reviewedByUserId ? (nameById.get(r.reviewedByUserId) ?? null) : null,
      reviewedAt: r.reviewedAt,
      reviewNotes: r.reviewNotes,
      originalStartedAt: r.originalStartedAt,
      correctedByName: r.correctedByUserId ? (nameById.get(r.correctedByUserId) ?? null) : null,
      correctedAt: r.correctedAt,
      correctionReason: r.correctionReason,
    }));
  }

  /** Acknowledge a technician's pause. The interval is untouched — it has been
   *  running from the technician's own timestamp all along. */
  async approvePause(orderId: string, pauseId: string, userId: string) {
    const pause = await this.prisma.serviceOrderPause.findFirst({
      where: { id: pauseId, serviceOrderId: orderId },
    });
    if (!pause) throw new NotFoundException(`Pause ${pauseId} not found on order ${orderId}`);
    if (pause.approvalStatus !== 'PENDING') {
      throw new BadRequestException(`This pause has already been reviewed (${pause.approvalStatus}).`);
    }

    const updated = await this.prisma.serviceOrderPause.update({
      where: { id: pauseId },
      data: { approvalStatus: 'APPROVED', reviewedByUserId: userId, reviewedAt: new Date() },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'PAUSE_APPROVED',
      entityType: 'ServiceOrderPause',
      entityId: pauseId,
      afterJson: { reasonCode: pause.reasonCode, effectiveFrom: pause.startedAt },
      notes: `Pause acknowledged; effective from ${pause.startedAt.toISOString()} (the technician's own timestamp).`,
    });

    return updated;
  }

  /**
   * Reject a pending pause. Requires a reason; the original request is kept in
   * full (marked REJECTED, never deleted). If the job is still stopped, it is
   * resumed — the interval closes honestly at the moment of rejection, because
   * the work genuinely was stopped until then.
   */
  async rejectPause(orderId: string, pauseId: string, reason: string, userId: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('Rejecting a pause requires a reason.');
    }
    const pause = await this.prisma.serviceOrderPause.findFirst({
      where: { id: pauseId, serviceOrderId: orderId },
    });
    if (!pause) throw new NotFoundException(`Pause ${pauseId} not found on order ${orderId}`);
    if (pause.approvalStatus !== 'PENDING') {
      throw new BadRequestException(`This pause has already been reviewed (${pause.approvalStatus}).`);
    }

    const updated = await this.prisma.serviceOrderPause.update({
      where: { id: pauseId },
      data: {
        approvalStatus: 'REJECTED',
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        reviewNotes: reason.trim(),
      },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'PAUSE_REJECTED',
      entityType: 'ServiceOrderPause',
      entityId: pauseId,
      beforeJson: { reasonCode: pause.reasonCode, requestedAt: pause.startedAt },
      afterJson: { approvalStatus: 'REJECTED' },
      notes: reason.trim(),
    });

    // Resume the work if this pause still has it stopped.
    if (!pause.endedAt) {
      const order = await this.findById(orderId);
      if (['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'].includes(order.status)) {
        await this.resume(orderId, { notes: `Pause rejected: ${reason.trim()}` }, userId);
      }
    }

    return updated;
  }

  /**
   * Controlled retroactive correction of when a pause took effect (CR-2026-100).
   *
   * "I actually stopped at 11:05" — recorded at 11:20. The effective start can
   * only move EARLIER than the recorded time (the recorded press proves work had
   * stopped by then; moving it later would fabricate labour). The original
   * timestamp is preserved on the row, the change is reasoned and audited, and
   * the labour segments that ran past the true stop are trimmed through the
   * segment-correction path, which writes its own audit trail.
   */
  async correctPauseStart(
    orderId: string,
    pauseId: string,
    dto: { effectiveFrom: string; reason: string },
    userId: string,
  ) {
    if (!dto.reason?.trim()) {
      throw new BadRequestException('Correcting a pause time requires a reason.');
    }
    const newStart = new Date(dto.effectiveFrom);
    if (Number.isNaN(newStart.getTime())) {
      throw new BadRequestException('effectiveFrom must be a valid date/time.');
    }

    const pause = await this.prisma.serviceOrderPause.findFirst({
      where: { id: pauseId, serviceOrderId: orderId },
    });
    if (!pause) throw new NotFoundException(`Pause ${pauseId} not found on order ${orderId}`);
    if (newStart >= pause.startedAt) {
      throw new BadRequestException(
        'The effective start can only be moved earlier than the recorded time.',
      );
    }
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: orderId },
      select: { startedAt: true },
    });
    if (order?.startedAt && newStart < order.startedAt) {
      throw new BadRequestException('The pause cannot start before work started on the job.');
    }

    const updated = await this.prisma.serviceOrderPause.update({
      where: { id: pauseId },
      data: {
        startedAt: newStart,
        // Only the FIRST correction sets this — the original is never lost.
        originalStartedAt: pause.originalStartedAt ?? pause.startedAt,
        correctedByUserId: userId,
        correctedAt: new Date(),
        correctionReason: dto.reason.trim(),
      },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'PAUSE_TIME_CORRECTED',
      entityType: 'ServiceOrderPause',
      entityId: pauseId,
      beforeJson: { startedAt: pause.startedAt },
      afterJson: { startedAt: newStart },
      notes: dto.reason.trim(),
    });

    // Trim the labour segments this pause closed: anything that kept accruing
    // between the true stop and the recorded press is not labour. The 60-second
    // tolerance covers the two clock reads at pause time (ledger row vs segment
    // close are milliseconds apart, never minutes).
    const closedByThisPause = await this.prisma.technicianWorkSegment.findMany({
      where: {
        serviceOrderId: orderId,
        endReason: 'PAUSED',
        endedAt: { gt: newStart, lte: new Date(pause.startedAt.getTime() + 60_000) },
      },
      select: { id: true, startedAt: true },
    });
    for (const seg of closedByThisPause) {
      const trimmedEnd = newStart < seg.startedAt ? seg.startedAt : newStart;
      await this.segments.correctSegment(
        seg.id,
        { endedAt: trimmedEnd, reason: `Pause time corrected: ${dto.reason.trim()}` },
        userId,
      );
    }

    this.logger.log(
      `Pause ${pauseId} effective start corrected to ${newStart.toISOString()} by ${userId} ` +
        `(${closedByThisPause.length} labour segment(s) trimmed)`,
    );
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

  async assignAdditional(orderId: string, technicianId: string, bayId?: string, resourceId?: string, userId?: string, acknowledgeWorkload?: boolean) {
    const order = await this.findById(orderId);
    if (!['APPROVED', 'ASSIGNED', 'IN_PROGRESS'].includes(order.status)) {
      throw new BadRequestException(`Cannot add technician to order in status ${order.status}`);
    }

    // CR-2026-100 — same workload warning as assign(): open work on other visits
    // is surfaced for judgement, not hard-blocked. Same-visit orders never trip it.
    await this.assertWorkloadAcknowledged(
      technicianId,
      order.serviceVisitId,
      acknowledgeWorkload === true,
      userId ?? null,
    );

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

  async startAssignment(
    orderId: string,
    assignmentId: string,
    userId: string,
    dto?: { holdReasonCode?: PauseReason; holdNotes?: string },
  ) {
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

    // CR-2026-100 — one person cannot productively work two jobs at once. An open
    // labour segment on ANOTHER order means the previous job's clock is still
    // running; starting here without settling that would double-count the same
    // real hour on two jobs. The technician is prompted to switch: the previous
    // job is held (with a stated reason), or — when colleagues are still working
    // it — only this technician's segment closes and the job carries on.
    const openElsewhere = await this.prisma.technicianWorkSegment.findMany({
      where: { technicianId: tech.id, endedAt: null, serviceOrderId: { not: orderId } },
      select: {
        id: true,
        serviceOrderId: true,
        serviceOrder: {
          select: {
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
    });

    if (openElsewhere.length > 0) {
      const activeJobs = [...new Map(openElsewhere.map((s) => [s.serviceOrderId, s])).values()].map(
        (s) => ({
          orderId: s.serviceOrderId,
          ticketNumber: s.serviceOrder.serviceVisit.queueTicket?.ticketNumber ?? null,
          plate: s.serviceOrder.serviceVisit.vehicle.plateNumber,
        }),
      );

      if (!dto?.holdReasonCode) {
        throw new ConflictException({
          message:
            'You are still on the clock for another job. Hold it (with a reason) to switch, or finish it first.',
          code: 'ACTIVE_WORK_ELSEWHERE',
          activeJobs,
        });
      }
    }

    // CR-2026-088 — KPI-tracked work needs a confirmed Sedan/SUV class, because the
    // class picks the standard the job will be measured against. Asking at the point
    // of starting is the last honest moment: afterwards the clock is already running
    // and any classification looks like it was chosen to suit the result.
    //
    // CR-2026-100 — these gates run BEFORE the switch below is executed: if this
    // job cannot start, the previous job must not have been held for it. The live
    // validation caught exactly that half-applied switch.
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

    // Execute the switch: this job is clear to start, so the previous work is
    // settled now — held (sole worker) or stepped off (colleagues remain).
    if (openElsewhere.length > 0 && dto?.holdReasonCode) {
      const activeJobs = [...new Map(openElsewhere.map((s) => [s.serviceOrderId, s])).values()];
      for (const job of activeJobs) {
        const colleaguesStillWorking = await this.prisma.technicianWorkSegment.count({
          where: { serviceOrderId: job.serviceOrderId, endedAt: null, technicianId: { not: tech.id } },
        });
        if (colleaguesStillWorking > 0) {
          // Others keep the job going — only this technician steps off it.
          await this.segments.endSegment({
            serviceOrderId: job.serviceOrderId,
            technicianId: tech.id,
            endReason: 'SWITCHED_JOB',
            actorUserId: userId,
          });
        } else {
          // Sole worker: the job itself is held, honestly and with the stated
          // reason (WAITING_PARTS / WAITING_CUSTOMER route to their first-class
          // states; attribution marks it as the technician's own pause).
          await this.pause(
            job.serviceOrderId,
            { reasonCode: dto.holdReasonCode, notes: dto.holdNotes },
            userId,
          );
        }
        await this.auditService.log({
          actorUserId: userId,
          action: 'WORK_SWITCHED',
          entityType: 'ServiceOrder',
          entityId: job.serviceOrderId,
          afterJson: { switchedToOrderId: orderId, holdReason: dto.holdReasonCode },
          notes: dto.holdNotes,
        });
      }
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
      select: {
        startedAt: true,
        endedAt: true,
        reasonCode: true,
        notes: true,
        approvalStatus: true,
        enteredOnBehalf: true,
      },
    });

    let pausedMs = 0;
    let openPauseStartedAt: Date | null = null;
    let openPauseReason: string | null = null;
    let openPauseNotes: string | null = null;
    let openPauseApprovalStatus: string | null = null;
    let openPauseEnteredOnBehalf = false;
    // CR-2026-098 — parts delays broken out so the UI and metrics can show
    // "waiting on parts" distinctly from ordinary pauses.
    // CR-2026-100 — the full breakdown: parts / customer / other, so a job's
    // elapsed time is explainable, not an unexplained average.
    let waitingPartsMs = 0;
    let waitingCustomerMs = 0;
    for (const p of pauses) {
      if (p.endedAt) {
        const ms = p.endedAt.getTime() - p.startedAt.getTime();
        pausedMs += ms;
        if (p.reasonCode === 'WAITING_PARTS') waitingPartsMs += ms;
        else if (p.reasonCode === 'CUSTOMER_AUTHORIZATION') waitingCustomerMs += ms;
      } else {
        openPauseStartedAt = p.startedAt;
        openPauseReason = p.reasonCode;
        openPauseNotes = p.notes;
        openPauseApprovalStatus = p.approvalStatus;
        openPauseEnteredOnBehalf = p.enteredOnBehalf;
      }
    }

    return {
      startedAt: order.startedAt,
      completedAt: order.completedAt,
      status: order.status,
      pausedMs,
      waitingPartsMs,
      waitingCustomerMs,
      otherPausedMs: pausedMs - waitingPartsMs - waitingCustomerMs,
      openPauseStartedAt,
      openPauseReason,
      openPauseNotes,
      openPauseApprovalStatus,
      openPauseEnteredOnBehalf,
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
  /**
   * CR-2026-100 — workload visibility instead of a hard block.
   *
   * The old rule ("has an active assignment on another visit → refuse") pretended
   * a technician can only ever hold one job. In the real workshop one car waits
   * on parts while another is worked, and a third small job may sit assigned. So:
   * the FIRST attempt returns a 409 carrying the technician's current workload —
   * active vs held jobs, spelled out — and the advisor/manager assigns anyway
   * with `acknowledgeWorkload`, which is audited. Multiple orders on the same
   * visit are one job (CR-2026-068) and never trip this.
   */
  private async assertWorkloadAcknowledged(
    technicianId: string,
    serviceVisitId: string,
    acknowledged: boolean,
    actorUserId: string | null,
  ): Promise<void> {
    const openAssignments = await this.prisma.technicianAssignment.findMany({
      where: {
        technicianId,
        endedAt: null,
        status: { notIn: ['COMPLETED', 'REMOVED', 'CANCELLED'] },
        serviceOrder: { serviceVisitId: { not: serviceVisitId } },
      },
      select: {
        id: true,
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
    });
    if (openAssignments.length === 0) return;

    const HELD = new Set(['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER']);
    const workload = openAssignments.map((a) => ({
      orderId: a.serviceOrder.id,
      orderStatus: a.serviceOrder.status,
      held: HELD.has(a.serviceOrder.status),
      ticketNumber: a.serviceOrder.serviceVisit.queueTicket?.ticketNumber ?? null,
      plate: a.serviceOrder.serviceVisit.vehicle.plateNumber,
    }));
    const activeCount = workload.filter((w) => !w.held).length;
    const heldCount = workload.length - activeCount;

    if (!acknowledged) {
      throw new ConflictException({
        message:
          `This technician already has ${workload.length} open job(s) ` +
          `(${activeCount} active, ${heldCount} on hold). Review the workload and assign anyway if appropriate.`,
        code: 'TECHNICIAN_HAS_OPEN_WORK',
        workload,
      });
    }

    await this.auditService.log({
      actorUserId,
      action: 'ASSIGNMENT_WORKLOAD_ACKNOWLEDGED',
      entityType: 'Technician',
      entityId: technicianId,
      afterJson: { openJobs: workload.length, active: activeCount, held: heldCount, workload },
      notes: 'Assigned with existing open workload, acknowledged by the assigner.',
    });
  }

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
    // CR-2026-098b — derive from ALL of the visit's orders (see deriveTicketStatus).
    const siblings = await this.prisma.serviceOrder.findMany({
      where: { serviceVisitId },
      select: { status: true },
    });
    const target = deriveTicketStatus(siblings.map((o) => o.status));
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
