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
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { generateTicketNumber } from '../../common/helpers/ticket-generator';

/**
 * Check-in service for appointment-based arrivals.
 *
 * Flow:
 * 1. Load appointment with relations
 * 2. Validate status (CONFIRMED or DRAFT only)
 * 3. Validate no duplicate active visit (ARR-007)
 * 4. Create ServiceVisit (APPOINTMENT source, CHECKED_IN status)
 * 5. Generate ticket number + check-in sequence
 * 6. Create QueueTicket (PENDING_RANK — scheduler has not yet run)
 * 7. Transition Appointment to CHECKED_IN
 * 8. Record StatusHistory entries
 * 9. Return visit + ticket + placeholder priority
 */
@Injectable()
export class CheckInService {
  private readonly logger = new Logger(CheckInService.name);

  constructor(
    private prisma: PrismaService,
    private statusHistory: StatusHistoryService,
    private auditService: AuditService,
  ) {}

  /**
   * Check in a customer for an existing appointment.
   *
   * @param appointmentId - The appointment UUID
   * @param userId        - The acting user (from JWT)
   * @param arrivalAt     - Optional override for the arrival timestamp
   * @param notes         - Optional check-in notes
   */
  async checkIn(
    appointmentId: string,
    userId: string,
    arrivalAt?: Date,
    notes?: string,
    intake?: {
      mileageIn?: number;
      oilBrand?: string;
      oilGrade?: string;
      vehicleWeightClass?: string;
    },
  ) {
    const now = arrivalAt ?? new Date();

    // -----------------------------------------------------------------------
    // 1. Load appointment with required relations
    // -----------------------------------------------------------------------
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        services: { include: { serviceType: true } },
        customer: true,
        vehicle: true,
        site: true,
        serviceVisit: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException(
        `Appointment ${appointmentId} not found`,
      );
    }

    // -----------------------------------------------------------------------
    // 2. Validate appointment status
    // -----------------------------------------------------------------------
    if (!['CONFIRMED', 'DRAFT'].includes(appointment.status)) {
      throw new BadRequestException(
        `Cannot check in appointment in status ${appointment.status}`,
      );
    }

    if (appointment.serviceVisit) {
      throw new BadRequestException(
        'This appointment has already been checked in',
      );
    }

    // -----------------------------------------------------------------------
    // 3. ARR-007: No duplicate active visit for same customer+vehicle+site+day
    // -----------------------------------------------------------------------
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const duplicateVisit = await this.prisma.serviceVisit.findFirst({
      where: {
        customerId: appointment.customerId,
        vehicleId: appointment.vehicleId,
        siteId: appointment.siteId,
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
    // 4–7. Create ServiceVisit, QueueTicket, update Appointment — all in tx
    // -----------------------------------------------------------------------
    const siteCode = appointment.site.code;
    const siteTimezone = appointment.site.timezone ?? 'America/Jamaica';

    const result = await this.prisma.$transaction(
      async (tx) => {
        // 4. Create ServiceVisit with v4.1 intake fields + status token
        const statusToken = randomBytes(16).toString('hex');
        const tokenExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

        const serviceVisit = await tx.serviceVisit.create({
          data: {
            siteId: appointment.siteId,
            customerId: appointment.customerId,
            vehicleId: appointment.vehicleId,
            appointmentId: appointment.id,
            sourceType: 'APPOINTMENT',
            status: 'CHECKED_IN',
            arrivalAt: now,
            checkedInAt: now,
            notes: notes ?? null,
            mileageIn: intake?.mileageIn ?? null,
            oilBrandRequested: intake?.oilBrand ?? null,
            oilGradeRequested: intake?.oilGrade ?? null,
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

        // 5. Generate ticket number + sequence
        const { ticketNumber, checkinSequence } =
          await generateTicketNumber(
            tx as any,
            appointment.siteId,
            siteCode,
            siteTimezone,
          );

        // 6. Create QueueTicket
        const queueTicket = await tx.queueTicket.create({
          data: {
            serviceVisitId: serviceVisit.id,
            ticketNumber,
            checkinSequence,
            displayStatus: 'PENDING_RANK',
          },
        });

        // 7. Transition Appointment → CHECKED_IN
        await tx.appointment.update({
          where: { id: appointment.id },
          data: { status: 'CHECKED_IN' },
        });

        // 7b. Update vehicle weight class if provided
        if (intake?.vehicleWeightClass) {
          await tx.vehicle.update({
            where: { id: appointment.vehicleId },
            data: { weightClass: intake.vehicleWeightClass as any },
          });
        }

        // 7c. Update vehicle odometer if mileage provided
        if (intake?.mileageIn) {
          await tx.vehicle.update({
            where: { id: appointment.vehicleId },
            data: { odometer: intake.mileageIn },
          });
        }

        return { serviceVisit, queueTicket, statusToken };
      },
      {
        // Use serializable isolation for sequence generation safety
        isolationLevel: 'Serializable',
      },
    );

    // -----------------------------------------------------------------------
    // 8. Record StatusHistory entries (outside tx — best effort)
    // -----------------------------------------------------------------------
    await Promise.all([
      this.statusHistory.record({
        entityType: 'Appointment',
        entityId: appointment.id,
        fromStatus: appointment.status,
        toStatus: 'CHECKED_IN',
        changedByUserId: userId,
      }),
      this.statusHistory.record({
        entityType: 'ServiceVisit',
        entityId: result.serviceVisit.id,
        fromStatus: null,
        toStatus: 'CHECKED_IN',
        changedByUserId: userId,
      }),
    ]);

    this.logger.log(
      `[CHECK_IN] Appointment ${appointment.id} checked in → ` +
        `ServiceVisit ${result.serviceVisit.id}, ` +
        `Ticket ${result.queueTicket.ticketNumber}`,
    );

    // -----------------------------------------------------------------------
    // 9. Return response
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
