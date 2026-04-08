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
import { CreatePartsRequestDto } from './dto/create-parts-request.dto';
import { ReservePartsDto } from './dto/reserve-parts.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';

@Injectable()
export class PartsService {
  private readonly logger = new Logger(PartsService.name);

  constructor(
    private prisma: PrismaService,
    private statusHistory: StatusHistoryService,
    private auditService: AuditService,
    private schedulingService: SchedulingService,
  ) {}

  // ---------------------------------------------------------------------------
  // CREATE PARTS REQUEST
  // ---------------------------------------------------------------------------

  async createRequest(data: CreatePartsRequestDto, userId: string) {
    if (!data.items || data.items.length === 0) {
      throw new BadRequestException('At least one parts item is required');
    }

    // Validate the service order exists
    const serviceOrder = await this.prisma.serviceOrder.findUnique({
      where: { id: data.serviceOrderId },
    });

    if (!serviceOrder) {
      throw new NotFoundException(
        `ServiceOrder ${data.serviceOrderId} not found`,
      );
    }

    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.partsRequest.create({
        data: {
          serviceOrderId: data.serviceOrderId,
          status: 'OPEN',
          requiredByAt: data.requiredByAt
            ? new Date(data.requiredByAt)
            : undefined,
          notes: data.notes,
          createdByUserId: userId,
          items: {
            create: data.items.map((item) => ({
              sku: item.sku,
              description: item.description,
              qtyRequested: item.qtyRequested,
              qtyReserved: 0,
              criticalFlag: item.criticalFlag ?? false,
              status: 'PENDING',
            })),
          },
        },
        include: {
          items: true,
        },
      });

      return created;
    });

    await this.statusHistory.record({
      entityType: 'PartsRequest',
      entityId: request.id,
      fromStatus: null,
      toStatus: 'OPEN',
      changedByUserId: userId,
    });

    this.logger.log(
      `PartsRequest ${request.id} created for ServiceOrder ${data.serviceOrderId} with ${data.items.length} item(s)`,
    );

    return request;
  }

  // ---------------------------------------------------------------------------
  // FIND REQUEST BY ID
  // ---------------------------------------------------------------------------

  async findRequestById(id: string) {
    const request = await this.prisma.partsRequest.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            reservations: true,
          },
        },
        inventoryTransfers: true,
        serviceOrder: {
          include: {
            serviceVisit: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException(`PartsRequest ${id} not found`);
    }

    return request;
  }

  // ---------------------------------------------------------------------------
  // FIND BY SERVICE ORDER
  // ---------------------------------------------------------------------------

  async findByServiceOrder(serviceOrderId: string) {
    return this.prisma.partsRequest.findMany({
      where: { serviceOrderId },
      orderBy: { createdAt: 'asc' },
      include: {
        items: {
          include: {
            reservations: true,
          },
        },
        inventoryTransfers: true,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // RESERVE PARTS
  // ---------------------------------------------------------------------------

  async reserveParts(requestId: string, dto: ReservePartsDto, userId: string) {
    const request = await this.findRequestById(requestId) as any;
    const fromStatus = request.status;

    // Build a lookup of items belonging to this request
    const itemMap = new Map((request.items as any[]).map((item: any) => [item.id, item]));

    // Validate all reservation items belong to this request
    for (const res of dto.reservations) {
      if (!itemMap.has(res.partsRequestItemId)) {
        throw new BadRequestException(
          `PartsRequestItem ${res.partsRequestItemId} does not belong to PartsRequest ${requestId}`,
        );
      }
    }

    const updatedRequest = await this.prisma.$transaction(async (tx) => {
      // 1. Create reservations and update item quantities
      for (const res of dto.reservations) {
        const item = itemMap.get(res.partsRequestItemId)!;
        const newReserved = item.qtyReserved + res.qty;

        if (newReserved > item.qtyRequested) {
          throw new BadRequestException(
            `Reservation for item ${res.partsRequestItemId} would exceed requested qty (${item.qtyRequested}). Already reserved: ${item.qtyReserved}, attempting: ${res.qty}`,
          );
        }

        await tx.partsReservation.create({
          data: {
            partsRequestItemId: res.partsRequestItemId,
            inventoryLocationCode: res.inventoryLocationCode ?? 'DEFAULT',
            qtyReserved: res.qty,
            reservedAt: new Date(),
            status: 'ACTIVE',
          },
        });

        const itemStatus =
          newReserved >= item.qtyRequested ? 'FULFILLED' : 'PARTIAL';

        await tx.partsRequestItem.update({
          where: { id: res.partsRequestItemId },
          data: {
            qtyReserved: newReserved,
            status: itemStatus,
          },
        });

        // Update our local copy for subsequent iterations
        item.qtyReserved = newReserved;
      }

      // 2. Re-read all items to determine overall request status
      const allItems = await tx.partsRequestItem.findMany({
        where: { partsRequestId: requestId },
      });

      const allFulfilled = allItems.every(
        (i) => Number(i.qtyReserved) >= Number(i.qtyRequested),
      );
      const someFulfilled = allItems.some((i) => Number(i.qtyReserved) > 0);

      const newRequestStatus = allFulfilled
        ? 'READY'
        : someFulfilled
          ? 'PARTIAL'
          : 'RESERVING';

      const updated = await tx.partsRequest.update({
        where: { id: requestId },
        data: { status: newRequestStatus },
        include: {
          items: { include: { reservations: true } },
          inventoryTransfers: true,
          serviceOrder: { include: { serviceVisit: true } },
        },
      });

      return updated;
    });

    // Record status history if status changed
    if (updatedRequest.status !== fromStatus) {
      await this.statusHistory.record({
        entityType: 'PartsRequest',
        entityId: requestId,
        fromStatus,
        toStatus: updatedRequest.status,
        changedByUserId: userId,
        notes: `Parts reserved: ${dto.reservations.length} reservation(s)`,
      });
    }

    // If parts became READY, trigger queue recompute to unblock BLOCKED_PARTS visits
    if (updatedRequest.status === 'READY' && fromStatus !== 'READY') {
      const siteId = updatedRequest.serviceOrder?.serviceVisit?.siteId;
      if (siteId) {
        await this.triggerQueueRecompute(siteId);
      }
    }

    this.logger.log(
      `PartsRequest ${requestId} reservation complete — status: ${updatedRequest.status}`,
    );

    return updatedRequest;
  }

  // ---------------------------------------------------------------------------
  // CREATE INVENTORY TRANSFER
  // ---------------------------------------------------------------------------

  async createTransfer(dto: CreateTransferDto, userId: string) {
    const request = await this.findRequestById(dto.partsRequestId);
    const fromStatus = request.status;

    const transfer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryTransfer.create({
        data: {
          partsRequestId: dto.partsRequestId,
          sourceSiteId: dto.sourceSiteId,
          destinationSiteId: dto.destinationSiteId,
          etaAt: dto.etaAt ? new Date(dto.etaAt) : undefined,
          status: 'REQUESTED',
        },
      });

      await tx.partsRequest.update({
        where: { id: dto.partsRequestId },
        data: { status: 'TRANSFER_IN_PROGRESS' },
      });

      return created;
    });

    await this.statusHistory.record({
      entityType: 'PartsRequest',
      entityId: dto.partsRequestId,
      fromStatus,
      toStatus: 'TRANSFER_IN_PROGRESS',
      changedByUserId: userId,
      notes: `Transfer created from site ${dto.sourceSiteId} to ${dto.destinationSiteId}`,
    });

    await this.statusHistory.record({
      entityType: 'InventoryTransfer',
      entityId: transfer.id,
      fromStatus: null,
      toStatus: 'REQUESTED',
      changedByUserId: userId,
    });

    this.logger.log(
      `InventoryTransfer ${transfer.id} created for PartsRequest ${dto.partsRequestId}`,
    );

    return transfer;
  }

  // ---------------------------------------------------------------------------
  // RECEIVE TRANSFER
  // ---------------------------------------------------------------------------

  async receiveTransfer(transferId: string, userId: string) {
    const transfer = await this.prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
      include: {
        partsRequest: {
          include: {
            items: true,
            serviceOrder: { include: { serviceVisit: true } },
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException(`InventoryTransfer ${transferId} not found`);
    }

    if (transfer.status === 'RECEIVED') {
      throw new BadRequestException(
        `InventoryTransfer ${transferId} is already received`,
      );
    }

    if (transfer.status === 'CANCELLED') {
      throw new BadRequestException(
        `InventoryTransfer ${transferId} is cancelled`,
      );
    }

    const fromTransferStatus = transfer.status;

    await this.prisma.inventoryTransfer.update({
      where: { id: transferId },
      data: {
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    });

    await this.statusHistory.record({
      entityType: 'InventoryTransfer',
      entityId: transferId,
      fromStatus: fromTransferStatus,
      toStatus: 'RECEIVED',
      changedByUserId: userId,
    });

    // Check if all items on the parent request are now fully reserved
    const request = transfer.partsRequest;
    if (request) {
      const allFulfilled = request.items.every(
        (i) => i.qtyReserved >= i.qtyRequested,
      );

      if (allFulfilled) {
        const fromRequestStatus = request.status;

        await this.prisma.partsRequest.update({
          where: { id: request.id },
          data: { status: 'READY' },
        });

        await this.statusHistory.record({
          entityType: 'PartsRequest',
          entityId: request.id,
          fromStatus: fromRequestStatus,
          toStatus: 'READY',
          changedByUserId: userId,
          notes: 'All items fulfilled after transfer received',
        });

        // Trigger queue recompute to unblock BLOCKED_PARTS visits
        const siteId = request.serviceOrder?.serviceVisit?.siteId;
        if (siteId) {
          await this.triggerQueueRecompute(siteId);
        }
      } else {
        // Update to RECEIVED even if not fully ready — transfer itself is done
        const fromRequestStatus = request.status;
        if (fromRequestStatus === 'TRANSFER_IN_PROGRESS') {
          // Check if there are other pending transfers
          const pendingTransfers = await this.prisma.inventoryTransfer.count({
            where: {
              partsRequestId: request.id,
              status: { notIn: ['RECEIVED', 'CANCELLED'] },
            },
          });

          if (pendingTransfers === 0) {
            await this.prisma.partsRequest.update({
              where: { id: request.id },
              data: { status: 'PARTIAL' },
            });

            await this.statusHistory.record({
              entityType: 'PartsRequest',
              entityId: request.id,
              fromStatus: fromRequestStatus,
              toStatus: 'PARTIAL',
              changedByUserId: userId,
              notes: 'All transfers received but items not fully reserved',
            });
          }
        }
      }
    }

    this.logger.log(`InventoryTransfer ${transferId} marked as RECEIVED`);

    return this.prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
      include: { partsRequest: { include: { items: true } } },
    });
  }

  // ---------------------------------------------------------------------------
  // PARTS READINESS DASHBOARD
  // ---------------------------------------------------------------------------

  async getPartsReadinessDashboard(siteId: string) {
    // Find service orders with unresolved parts requests
    // for upcoming / active jobs at the given site
    const orders = await this.prisma.serviceOrder.findMany({
      where: {
        status: { in: ['DRAFT', 'APPROVED', 'ASSIGNED'] },
        serviceVisit: {
          siteId,
        },
        partsRequests: {
          some: {
            status: { notIn: ['READY', 'CLOSED', 'CANCELLED'] },
          },
        },
      },
      include: {
        serviceVisit: {
          include: {
            customer: true,
            vehicle: true,
          },
        },
        items: {
          include: { serviceType: true },
        },
        partsRequests: {
          include: {
            items: {
              include: { reservations: true },
            },
            inventoryTransfers: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return orders.map((order) => ({
      serviceOrderId: order.id,
      serviceOrderStatus: order.status,
      promisedCompletionAt: order.promisedCompletionAt,
      serviceVisit: {
        id: order.serviceVisit.id,
        status: order.serviceVisit.status,
        customer: order.serviceVisit.customer
          ? {
              id: order.serviceVisit.customer.id,
              firstName: (order.serviceVisit.customer as any).firstName,
              lastName: (order.serviceVisit.customer as any).lastName,
              phone: (order.serviceVisit.customer as any).phone,
            }
          : null,
        vehicle: order.serviceVisit.vehicle
          ? {
              id: order.serviceVisit.vehicle.id,
              plate: (order.serviceVisit.vehicle as any).plate,
              make: (order.serviceVisit.vehicle as any).make,
              model: (order.serviceVisit.vehicle as any).model,
              year: (order.serviceVisit.vehicle as any).year,
            }
          : null,
      },
      services: order.items.map((item) => ({
        serviceTypeCode: item.serviceType.code,
        serviceTypeName: item.serviceType.name,
      })),
      partsRequests: order.partsRequests.map((pr) => ({
        id: pr.id,
        status: pr.status,
        requiredByAt: pr.requiredByAt,
        items: pr.items.map((item) => ({
          id: item.id,
          sku: item.sku,
          description: item.description,
          qtyRequested: item.qtyRequested,
          qtyReserved: item.qtyReserved,
          criticalFlag: item.criticalFlag,
          status: item.status,
        })),
        transfers: pr.inventoryTransfers.map((t: any) => ({
          id: t.id,
          status: t.status,
          etaAt: t.etaAt,
          shippedAt: t.shippedAt,
          receivedAt: t.receivedAt,
        })),
      })),
    }));
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Trigger a queue recompute for the given site.
   * Failures are logged but do not block the calling operation.
   */
  private async triggerQueueRecompute(siteId: string): Promise<void> {
    try {
      await this.schedulingService.recomputeQueue(siteId);
      this.logger.log(`Queue recompute triggered for site ${siteId} (parts readiness change)`);
    } catch (err) {
      this.logger.error(
        `Queue recompute failed for site ${siteId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
