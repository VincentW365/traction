import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { SchedulingService } from '../scheduling/scheduling.service';
import { publicUrl } from '../../common/helpers/public-url';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { generateTicketNumber } from '../../common/helpers/ticket-generator';
import { allocateTicketIdentifiers } from '../../common/helpers/ticket-allocator';
import { assertMileageGate } from '../../common/helpers/mileage-gate';

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
    // CR-2026-105b — QUE-002: rank on check-in. Optional so the existing specs'
    // three-argument construction keeps working.
    @Optional() private scheduling?: SchedulingService,
  ) {}

  /**
   * CR-2026-105b — rank the new ticket and publish its estimate immediately,
   * instead of leaving it PENDING_RANK until some unrelated action recomputes.
   * Failure never fails the check-in: the next recompute picks the ticket up.
   */
  private async rankAndEstimate(siteId: string, serviceVisitId: string): Promise<Date | null> {
    if (!this.scheduling) return null;
    try {
      await this.scheduling.recomputeQueue(siteId);
      const sv = await this.prisma.serviceVisit.findUnique({
        where: { id: serviceVisitId },
        select: { currentEtaStartAt: true },
      });
      return sv?.currentEtaStartAt ?? null;
    } catch (err) {
      this.logger.error(`Queue recompute after check-in failed for site ${siteId}: ${(err as Error).message}`);
      return null;
    }
  }

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
      vehicleServiceClass?: string;
      color?: string;
      mileageOverride?: boolean;
      overrideReason?: string;
      notificationOptInSms?: boolean;
      notificationOptInEmail?: boolean;
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
    // 2. Validate appointment status — an upcoming, still-active appointment can be
    //    checked in. RESCHEDULED counts (CR-2026-070): moving the time keeps it active.
    // -----------------------------------------------------------------------
    if (!['CONFIRMED', 'DRAFT', 'RESCHEDULED'].includes(appointment.status)) {
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
    // 3b. DMAIC Rule 5: mileage gate (bidirectional + manager override)
    // -----------------------------------------------------------------------
    const requiresMileage = appointment.services.some(
      (s) => (s.serviceType as any).requiresMileage === true,
    );
    const mileageProvided = intake?.mileageIn != null;
    const mileageOverride = intake?.mileageOverride === true;
    assertMileageGate({ requiresMileage, mileageProvided, override: mileageOverride });

    // Audit any override that actually bypassed the gate.
    const gateWouldBlock =
      (requiresMileage && !mileageProvided) || (!requiresMileage && mileageProvided);
    if (mileageOverride && gateWouldBlock) {
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.MILEAGE_GATE_OVERRIDE,
        entityType: 'Appointment',
        entityId: appointment.id,
        afterJson: { requiresMileage, mileageProvided, mileageIn: intake?.mileageIn ?? null, boundary: 'CHECK_IN' },
        reasonCode: 'MILEAGE_GATE_OVERRIDE',
        notes: intake?.overrideReason,
      });
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

                // 5. Allocate the ticket identifiers (CR-2026-089).
        //
        // checkinSequence is still generated because the FIFO scheduler orders the
        // queue by it; the v2 identifiers are what people actually read. The two
        // are separate on purpose — arrival order is a scheduling input, the ticket
        // number is an immutable label, and conflating them is what made the old
        // format need a rewrite whenever the queue changed.
        const { checkinSequence } = await generateTicketNumber(
          tx as any,
          appointment.site.id,
          siteCode,
          siteTimezone,
        );
        const ids = await allocateTicketIdentifiers(tx as any, {
          id: appointment.site.id,
          code: siteCode,
          timezone: siteTimezone,
          ticketCode: appointment.site.ticketCode ?? null,
        });

        // 6. Create QueueTicket
        const queueTicket = await tx.queueTicket.create({
          data: {
            serviceVisitId: serviceVisit.id,
            // ticketNumber carries the full v2 reference so every existing consumer
            // shows the new format immediately; legacy rows keep their QTK-... value.
            ticketNumber: ids.ticketReference,
            ticketReference: ids.ticketReference,
            displayTicketNumber: ids.displayTicketNumber,
            locationCodeSnapshot: ids.locationCodeSnapshot,
            businessDate: ids.businessDate,
            dailySequence: ids.dailySequence,
            checkinSequence,
            displayStatus: 'PENDING_RANK',
          },
        });

        // CR-2026-097 — the ticket reference IS the visit's human identity.
        await tx.serviceVisit.update({
          where: { id: serviceVisit.id },
          data: { visitNumber: ids.ticketReference },
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

        // 7b-ii. Update vehicle service class if provided (DMAIC Rule 3 — mobile-jack eligibility)
        if (intake?.vehicleServiceClass) {
          await tx.vehicle.update({
            where: { id: appointment.vehicleId },
            data: { serviceClass: intake.vehicleServiceClass as any },
          });
          // CR-2026-008 check-in parity: record the classification as CONFIRMED
          // (source CHECK_IN) so the audit/status trail matches the review queue.
          await tx.vehicleClassification.upsert({
            where: { vehicleId: appointment.vehicleId },
            create: {
              vehicleId: appointment.vehicleId,
              status: 'CONFIRMED',
              source: 'CHECK_IN',
              confirmedServiceClass: intake.vehicleServiceClass as any,
              confirmedWeightClass:
                (intake.vehicleWeightClass as any) ?? appointment.vehicle.weightClass ?? null,
              reviewedByUserId: userId,
              reviewedAt: now,
            },
            update: {
              status: 'CONFIRMED',
              source: 'CHECK_IN',
              confirmedServiceClass: intake.vehicleServiceClass as any,
              confirmedWeightClass:
                (intake.vehicleWeightClass as any) ?? appointment.vehicle.weightClass ?? null,
              reviewedByUserId: userId,
              reviewedAt: now,
            },
          });
        }

        // 7c. Update vehicle odometer if mileage provided
        if (intake?.mileageIn) {
          await tx.vehicle.update({
            where: { id: appointment.vehicleId },
            data: { odometer: intake.mileageIn },
          });
        }

        // 7d. Update vehicle color if provided
        if (intake?.color) {
          await tx.vehicle.update({
            where: { id: appointment.vehicleId },
            data: { color: intake.color },
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

    // CR-2026-008 check-in parity: if staff set/changed the operational
    // serviceClass at check-in, write the same audit + status trail as the
    // classification queue (the VehicleClassification row is written in the tx).
    if (intake?.vehicleServiceClass) {
      const beforeClass = {
        serviceClass: appointment.vehicle.serviceClass,
        weightClass: appointment.vehicle.weightClass,
      };
      const afterClass = {
        serviceClass: intake.vehicleServiceClass,
        weightClass: intake.vehicleWeightClass ?? appointment.vehicle.weightClass,
      };
      await Promise.all([
        this.auditService.log({
          actorUserId: userId,
          action: AUDIT_ACTIONS.VEHICLE_CLASSIFIED,
          entityType: 'Vehicle',
          entityId: appointment.vehicleId,
          beforeJson: beforeClass,
          afterJson: afterClass,
          reasonCode: 'CLASSIFICATION_CONFIRMED',
          notes: 'Set at check-in',
        }),
        this.statusHistory.record({
          entityType: 'Vehicle',
          entityId: appointment.vehicleId,
          fromStatus: beforeClass.serviceClass ?? null,
          toStatus: intake.vehicleServiceClass,
          changedByUserId: userId,
          reasonCode: 'CLASSIFICATION_CONFIRMED',
        }),
      ]);
    }

    // P4(b): capture notification consent if staff provided it. Default remains
    // whatever the customer already had — only an explicit value changes it, and
    // only an actual change is persisted/audited. No notifications are sent here.
    const optInUpdate: { notificationOptInSms?: boolean; notificationOptInEmail?: boolean } = {};
    if (
      intake?.notificationOptInSms !== undefined &&
      intake.notificationOptInSms !== appointment.customer.notificationOptInSms
    ) {
      optInUpdate.notificationOptInSms = intake.notificationOptInSms;
    }
    if (
      intake?.notificationOptInEmail !== undefined &&
      intake.notificationOptInEmail !== appointment.customer.notificationOptInEmail
    ) {
      optInUpdate.notificationOptInEmail = intake.notificationOptInEmail;
    }
    if (Object.keys(optInUpdate).length > 0) {
      const before = {
        notificationOptInSms: appointment.customer.notificationOptInSms,
        notificationOptInEmail: appointment.customer.notificationOptInEmail,
      };
      await this.prisma.customer.update({
        where: { id: appointment.customerId },
        data: optInUpdate,
      });
      await this.auditService.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.CUSTOMER_NOTIFICATION_OPTIN,
        entityType: 'Customer',
        entityId: appointment.customerId,
        beforeJson: before,
        afterJson: { ...before, ...optInUpdate },
        reasonCode: 'CHECKIN_CAPTURE',
        notes: 'Notification consent captured at check-in',
      });
    }

    this.logger.log(
      `[CHECK_IN] Appointment ${appointment.id} checked in → ` +
        `ServiceVisit ${result.serviceVisit.id}, ` +
        `Ticket ${result.queueTicket.ticketNumber}`,
    );

    // -----------------------------------------------------------------------
    // 9. Rank + estimate (CR-2026-105b), then return response
    // -----------------------------------------------------------------------
    const etaStartAt = await this.rankAndEstimate(result.serviceVisit.siteId, result.serviceVisit.id);

    return {
      serviceVisit: result.serviceVisit,
      queueTicket: result.queueTicket,
      priorityClass: 'PENDING' as const,
      etaStartAt,
      // CR-2026-106 — ABSOLUTE, from the ONE public base (docs/121 §C4). The web
      // used to prefix the path with the staff PC's own origin.
      customerStatusUrl: publicUrl(`/status/${result.statusToken}`),
      customerStatusPath: `/status/${result.statusToken}`,
    };
  }
}
