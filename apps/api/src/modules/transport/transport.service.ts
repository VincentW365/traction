import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TransportStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { CreateTransportRequestDto } from './dto/create-transport-request.dto';
import { AssignDriverDto } from './dto/assign-driver.dto';

// ---------------------------------------------------------------------------
// Valid status transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<TransportStatus, TransportStatus[]> = {
  REQUESTED: ['CONFIRMATION_PENDING', 'CANCELLED'],
  CONFIRMATION_PENDING: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['DRIVER_ASSIGNED', 'CANCELLED'],
  DRIVER_ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const ACTIVE_STATUSES: TransportStatus[] = [
  'REQUESTED',
  'CONFIRMATION_PENDING',
  'SCHEDULED',
  'DRIVER_ASSIGNED',
  'IN_PROGRESS',
];

@Injectable()
export class TransportService {
  private readonly logger = new Logger(TransportService.name);

  constructor(
    private prisma: PrismaService,
    private statusHistory: StatusHistoryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async create(dto: CreateTransportRequestDto, userId: string) {
    // Validate service visit exists
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: dto.serviceVisitId },
      include: {
        appointment: {
          include: {
            services: {
              include: { serviceType: true },
            },
          },
        },
      },
    });

    if (!visit) {
      throw new NotFoundException(
        `ServiceVisit ${dto.serviceVisitId} not found`,
      );
    }

    // Check transport eligibility — at least one service type must be transport-eligible
    const services = visit.appointment?.services ?? [];
    const hasEligible = services.some((s) => s.serviceType.transportEligible);

    if (!hasEligible) {
      throw new BadRequestException(
        'Transport is not eligible for this service visit — none of the requested service types allow transport',
      );
    }

    const request = await this.prisma.transportRequest.create({
      data: {
        serviceVisitId: dto.serviceVisitId,
        direction: dto.direction,
        status: 'REQUESTED',
        originAddress: dto.originAddress,
        destinationAddress: dto.destinationAddress,
        requestedPickupAt: dto.requestedPickupAt
          ? new Date(dto.requestedPickupAt)
          : undefined,
        notes: dto.notes,
      },
    });

    await this.statusHistory.record({
      entityType: 'TransportRequest',
      entityId: request.id,
      fromStatus: null,
      toStatus: 'REQUESTED',
      changedByUserId: userId,
    });

    this.logger.log(
      `Transport request ${request.id} created for visit ${dto.serviceVisitId}`,
    );

    return request;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async findById(id: string) {
    const request = await this.prisma.transportRequest.findUnique({
      where: { id },
      include: {
        serviceVisit: {
          include: { customer: true, vehicle: true },
        },
        driver: { select: { id: true, fullName: true, roleCode: true } },
      },
    });

    if (!request) {
      throw new NotFoundException(`TransportRequest ${id} not found`);
    }

    return request;
  }

  async findByVisit(serviceVisitId: string) {
    return this.prisma.transportRequest.findMany({
      where: { serviceVisitId },
      include: {
        driver: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  async confirmCustomer(id: string, userId: string) {
    return this.transition(id, 'CONFIRMATION_PENDING', userId);
  }

  async schedule(id: string, userId: string) {
    return this.transition(id, 'SCHEDULED', userId);
  }

  async assignDriver(id: string, dto: AssignDriverDto, userId: string) {
    const request = await this.findOrThrow(id);
    this.assertTransition(request.status, 'DRIVER_ASSIGNED');

    const updated = await this.prisma.transportRequest.update({
      where: { id },
      data: {
        status: 'DRIVER_ASSIGNED',
        driverUserId: dto.driverUserId,
        scheduledPickupAt: new Date(dto.scheduledPickupAt),
      },
    });

    await this.statusHistory.record({
      entityType: 'TransportRequest',
      entityId: id,
      fromStatus: request.status,
      toStatus: 'DRIVER_ASSIGNED',
      changedByUserId: userId,
    });

    this.logger.log(
      `Transport request ${id} assigned to driver ${dto.driverUserId}`,
    );

    return updated;
  }

  async start(id: string, userId: string) {
    const request = await this.findOrThrow(id);
    this.assertTransition(request.status, 'IN_PROGRESS');

    const updated = await this.prisma.transportRequest.update({
      where: { id },
      data: {
        status: 'IN_PROGRESS',
        actualStartAt: new Date(),
      },
    });

    await this.statusHistory.record({
      entityType: 'TransportRequest',
      entityId: id,
      fromStatus: request.status,
      toStatus: 'IN_PROGRESS',
      changedByUserId: userId,
    });

    return updated;
  }

  async complete(id: string, userId: string) {
    const request = await this.findOrThrow(id);
    this.assertTransition(request.status, 'COMPLETED');

    const updated = await this.prisma.transportRequest.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await this.statusHistory.record({
      entityType: 'TransportRequest',
      entityId: id,
      fromStatus: request.status,
      toStatus: 'COMPLETED',
      changedByUserId: userId,
    });

    return updated;
  }

  async cancel(id: string, userId: string, reason?: string) {
    const request = await this.findOrThrow(id);
    this.assertTransition(request.status, 'CANCELLED');

    const updated = await this.prisma.transportRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    await this.statusHistory.record({
      entityType: 'TransportRequest',
      entityId: id,
      fromStatus: request.status,
      toStatus: 'CANCELLED',
      changedByUserId: userId,
      notes: reason,
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Dispatch Board
  // ---------------------------------------------------------------------------

  async getDispatchBoard(siteId: string) {
    const requests = await this.prisma.transportRequest.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        serviceVisit: { siteId },
      },
      include: {
        serviceVisit: {
          include: {
            customer: {
              select: { firstName: true, lastName: true },
            },
            vehicle: {
              select: { plateNumber: true, make: true, model: true },
            },
          },
        },
        driver: { select: { id: true, fullName: true } },
      },
      orderBy: [{ requestedPickupAt: 'asc' }, { createdAt: 'asc' }],
    });

    // Group by logical buckets for dispatch view
    const pending = requests.filter((r) =>
      (['REQUESTED', 'CONFIRMATION_PENDING'] as TransportStatus[]).includes(
        r.status,
      ),
    );
    const scheduled = requests.filter((r) =>
      (['SCHEDULED', 'DRIVER_ASSIGNED'] as TransportStatus[]).includes(
        r.status,
      ),
    );
    const inProgress = requests.filter((r) => r.status === 'IN_PROGRESS');

    const mapItem = (r: (typeof requests)[number]) => ({
      id: r.id,
      direction: r.direction,
      status: r.status,
      customerName: `${r.serviceVisit.customer.firstName} ${r.serviceVisit.customer.lastName}`,
      vehiclePlate: r.serviceVisit.vehicle.plateNumber,
      requestedPickupAt: r.requestedPickupAt,
      scheduledPickupAt: r.scheduledPickupAt,
      driverName: r.driver?.fullName ?? null,
    });

    return {
      pending: pending.map(mapItem),
      scheduled: scheduled.map(mapItem),
      inProgress: inProgress.map(mapItem),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async findOrThrow(id: string) {
    const request = await this.prisma.transportRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException(`TransportRequest ${id} not found`);
    }

    return request;
  }

  private assertTransition(
    currentStatus: TransportStatus,
    targetStatus: TransportStatus,
  ) {
    const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${currentStatus} to ${targetStatus}`,
      );
    }
  }

  private async transition(
    id: string,
    targetStatus: TransportStatus,
    userId: string,
  ) {
    const request = await this.findOrThrow(id);
    this.assertTransition(request.status, targetStatus);

    const updated = await this.prisma.transportRequest.update({
      where: { id },
      data: { status: targetStatus },
    });

    await this.statusHistory.record({
      entityType: 'TransportRequest',
      entityId: id,
      fromStatus: request.status,
      toStatus: targetStatus,
      changedByUserId: userId,
    });

    return updated;
  }
}
