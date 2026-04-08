import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { CreateWalkInDto } from './dto/create-walk-in.dto';
import { generateTicketNumber } from '../../common/helpers/ticket-generator';

/**
 * Walk-in registration service.
 *
 * Flow:
 * 1. Validate site, customer, vehicle, and service types exist
 * 2. Validate no duplicate active visit (ARR-007)
 * 3. Create ServiceVisit (WALKIN source, CHECKED_IN status)
 * 4. Generate ticket number + check-in sequence
 * 5. Create QueueTicket (PENDING_RANK — scheduler has not yet run)
 * 6. Record StatusHistory
 * 7. Return visit + ticket + placeholder priority
 */
@Injectable()
export class WalkInsService {
  private readonly logger = new Logger(WalkInsService.name);

  constructor(
    private prisma: PrismaService,
    private statusHistory: StatusHistoryService,
  ) {}

  /**
   * Register a walk-in customer visit.
   *
   * @param data   - validated DTO with site, customer, vehicle, services
   * @param userId - acting user (from JWT)
   */
  async register(data: CreateWalkInDto, userId: string) {
    const now = new Date();

    // -----------------------------------------------------------------------
    // 1. Validate referenced entities exist
    // -----------------------------------------------------------------------
    const [site, customer, vehicle] = await Promise.all([
      this.prisma.site.findUnique({
        where: { id: data.siteId },
        select: { id: true, code: true, timezone: true, isActive: true },
      }),
      this.prisma.customer.findUnique({
        where: { id: data.customerId },
        select: { id: true, firstName: true, lastName: true, phone: true },
      }),
      this.prisma.vehicle.findUnique({
        where: { id: data.vehicleId },
        select: {
          id: true,
          customerId: true,
          plateNumber: true,
          make: true,
          model: true,
          modelYear: true,
        },
      }),
    ]);

    if (!site) {
      throw new NotFoundException(`Site ${data.siteId} not found`);
    }
    if (!site.isActive) {
      throw new BadRequestException(`Site ${data.siteId} is not active`);
    }
    if (!customer) {
      throw new NotFoundException(`Customer ${data.customerId} not found`);
    }
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${data.vehicleId} not found`);
    }

    // Validate service type codes
    const codes = data.serviceTypes.map((s) => s.serviceTypeCode);
    const uniqueCodes = [...new Set(codes)];

    const serviceTypes = await this.prisma.serviceType.findMany({
      where: { code: { in: uniqueCodes }, isActive: true },
      select: { id: true, code: true, baseDurationMinutes: true },
    });

    const serviceTypeMap = new Map(
      serviceTypes.map((st) => [st.code, st]),
    );

    const missing = uniqueCodes.filter((c) => !serviceTypeMap.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Unknown or inactive service type codes: ${missing.join(', ')}`,
      );
    }

    // -----------------------------------------------------------------------
    // 2. ARR-007: No duplicate active visit for same customer+vehicle+site+day
    // -----------------------------------------------------------------------
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const duplicateVisit = await this.prisma.serviceVisit.findFirst({
      where: {
        customerId: data.customerId,
        vehicleId: data.vehicleId,
        siteId: data.siteId,
        createdAt: { gte: dayStart, lt: dayEnd },
        status: {
          notIn: ['CLOSED', 'ABANDONED', 'CANCELLED'],
        },
      },
    });

    if (duplicateVisit) {
      throw new ConflictException(
        'An active service visit already exists for this customer, vehicle, and site today (ARR-007)',
      );
    }

    // -----------------------------------------------------------------------
    // 3–5. Create ServiceVisit + QueueTicket in a serializable transaction
    // -----------------------------------------------------------------------
    const siteCode = site.code;
    const siteTimezone = site.timezone ?? 'America/Jamaica';

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 3. Create ServiceVisit with v4.1 intake fields + status token
        const statusToken = randomBytes(16).toString('hex');
        const tokenExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const serviceVisit = await tx.serviceVisit.create({
          data: {
            siteId: data.siteId,
            customerId: data.customerId,
            vehicleId: data.vehicleId,
            sourceType: 'WALKIN',
            status: 'CHECKED_IN',
            arrivalAt: now,
            checkedInAt: now,
            notes: data.notes ?? null,
            mileageIn: data.mileageIn ?? null,
            oilBrandRequested: data.oilBrand ?? null,
            oilGradeRequested: data.oilGrade ?? null,
            customerStatusToken: statusToken,
            tokenExpiresAt: tokenExpiry,
          },
          include: {
            customer: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
            vehicle: {
              select: {
                id: true,
                plateNumber: true,
                make: true,
                model: true,
                modelYear: true,
              },
            },
          },
        });

        // 4. Generate ticket number + sequence
        const { ticketNumber, checkinSequence } =
          await generateTicketNumber(
            tx as any,
            data.siteId,
            siteCode,
            siteTimezone,
          );

        // 5. Create QueueTicket
        const queueTicket = await tx.queueTicket.create({
          data: {
            serviceVisitId: serviceVisit.id,
            ticketNumber,
            checkinSequence,
            displayStatus: 'PENDING_RANK',
          },
        });

        // Update vehicle weight class if provided
        if (data.vehicleWeightClass) {
          await tx.vehicle.update({
            where: { id: data.vehicleId },
            data: { weightClass: data.vehicleWeightClass as any },
          });
        }
        // Update vehicle odometer if mileage provided
        if (data.mileageIn) {
          await tx.vehicle.update({
            where: { id: data.vehicleId },
            data: { odometer: data.mileageIn },
          });
        }

        return { serviceVisit, queueTicket, statusToken };
      },
      {
        isolationLevel: 'Serializable',
      },
    );

    // -----------------------------------------------------------------------
    // 6. Record StatusHistory (outside tx — best effort)
    // -----------------------------------------------------------------------
    await this.statusHistory.record({
      entityType: 'ServiceVisit',
      entityId: result.serviceVisit.id,
      fromStatus: null,
      toStatus: 'CHECKED_IN',
      changedByUserId: userId,
    });

    this.logger.log(
      `[WALK_IN] Registered walk-in → ` +
        `ServiceVisit ${result.serviceVisit.id}, ` +
        `Ticket ${result.queueTicket.ticketNumber}`,
    );

    // -----------------------------------------------------------------------
    // 7. Return response
    // -----------------------------------------------------------------------
    return {
      serviceVisit: result.serviceVisit,
      queueTicket: result.queueTicket,
      priorityClass: 'PENDING' as const,
      etaStartAt: null,
      customerStatusUrl: `/status/${result.statusToken}`,
    };
  }
}
