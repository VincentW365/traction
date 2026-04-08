import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CreateServiceOrderDto } from './dto/create-service-order.dto';
import { AssignTechnicianDto } from './dto/assign-technician.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import { ServiceOrderStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Valid status transitions for ServiceOrder
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, ServiceOrderStatus[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_PARTS', 'QC', 'CANCELLED'],
  WAITING_PARTS: ['IN_PROGRESS', 'CANCELLED'],
  QC: ['READY_TO_INVOICE', 'CANCELLED'],
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

// Transitions that should trigger a queue recompute
const RECOMPUTE_TRIGGERS = new Set<ServiceOrderStatus>([
  'ASSIGNED' as ServiceOrderStatus,
  'IN_PROGRESS' as ServiceOrderStatus,
  'WAITING_PARTS' as ServiceOrderStatus,
  'QC' as ServiceOrderStatus,
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

    // 3. Load and validate the bay
    const bay = await this.prisma.workBay.findUnique({
      where: { id: dto.bayId },
    });

    if (!bay) {
      throw new NotFoundException(`Work bay ${dto.bayId} not found`);
    }

    if (bay.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Work bay ${dto.bayId} is not active`,
      );
    }

    // Validate bay type matches required bay types
    const requiredBayTypes = order.items
      .map((item) => item.serviceType.requiredBayType)
      .filter((bt): bt is string => bt != null);

    if (requiredBayTypes.length > 0 && !requiredBayTypes.includes(bay.bayType)) {
      throw new BadRequestException(
        `Bay type '${bay.bayType}' does not match required bay type(s): ${[...new Set(requiredBayTypes)].join(', ')}`,
      );
    }

    // 4. Check for double-booking: technician not in an active assignment
    const activeAssignment = await this.prisma.technicianAssignment.findFirst({
      where: {
        technicianId: dto.technicianId,
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        endedAt: null,
      },
    });

    if (activeAssignment) {
      throw new BadRequestException(
        `Technician ${dto.technicianId} already has an active assignment (${activeAssignment.id})`,
      );
    }

    // 5. Create TechnicianAssignment and update order status
    const [assignment, updated] = await this.prisma.$transaction(
      async (tx) => {
        const newAssignment = await tx.technicianAssignment.create({
          data: {
            serviceOrderId: id,
            technicianId: dto.technicianId,
            bayId: dto.bayId,
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
      `ServiceOrder ${id} assigned to technician ${dto.technicianId} in bay ${dto.bayId}`,
    );

    return updated;
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

    // Build update data with appropriate timestamp fields
    const updateData: Record<string, unknown> = { status: toStatus };

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
