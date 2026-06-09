import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';

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
}
