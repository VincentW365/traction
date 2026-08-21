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
import { CreateWalkInDto } from './dto/create-walk-in.dto';
import { generateTicketNumber } from '../../common/helpers/ticket-generator';
import { allocateTicketIdentifiers } from '../../common/helpers/ticket-allocator';
import { assertMileageGate } from '../../common/helpers/mileage-gate';

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
    private audit: AuditService,
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
        select: { id: true, code: true, timezone: true, isActive: true, ticketCode: true },
      }),
      this.prisma.customer.findUnique({
        where: { id: data.customerId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          // CR-2026-084 — needed to persist only an actual consent CHANGE.
          notificationOptInSms: true,
          notificationOptInEmail: true,
        },
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
      select: { id: true, code: true, baseDurationMinutes: true, requiresMileage: true },
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
    // 2b. DMAIC Rule 5: mileage gate (shared helper — matches check-in/completion)
    // -----------------------------------------------------------------------
    const requiresMileage = serviceTypes.some((st) => st.requiresMileage);
    const mileageProvided = data.mileageIn != null;
    const mileageOverride = data.mileageOverride === true;

    // Walk-in intake control: an override must carry a reason.
    if (mileageOverride && !data.overrideReason?.trim()) {
      throw new BadRequestException(
        'A manager override reason is required to bypass the mileage gate.',
      );
    }
    assertMileageGate({ requiresMileage, mileageProvided, override: mileageOverride });

    // Audit any override that actually bypassed the gate.
    const gateWouldBlock =
      (requiresMileage && !mileageProvided) || (!requiresMileage && mileageProvided);
    if (mileageOverride && gateWouldBlock) {
      await this.audit.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.MILEAGE_GATE_OVERRIDE,
        entityType: 'ServiceVisit',
        afterJson: {
          customerId: data.customerId,
          vehicleId: data.vehicleId,
          requiresMileage,
          mileageProvided,
          mileageIn: data.mileageIn ?? null,
          boundary: 'WALK_IN',
        },
        reasonCode: 'MILEAGE_GATE_OVERRIDE',
        notes: data.overrideReason,
      });
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

        // 4. Allocate the ticket identifiers (CR-2026-089).
        //
        // checkinSequence is still generated because the FIFO scheduler orders the
        // queue by it; the v2 identifiers are what people actually read. The two
        // are separate on purpose — arrival order is a scheduling input, the ticket
        // number is an immutable label, and conflating them is what would force a
        // renumber every time the queue changed.
        const { checkinSequence } = await generateTicketNumber(
          tx as any,
          data.siteId,
          siteCode,
          siteTimezone,
        );
        const ids = await allocateTicketIdentifiers(tx as any, {
          id: data.siteId,
          code: siteCode,
          timezone: siteTimezone,
          ticketCode: site.ticketCode ?? null,
        });

        // 5. Create QueueTicket
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

        // 5b. CR-2026-084 — persist the services chosen at registration.
        // Previously these codes were validated and then discarded, so a walk-in
        // had no record of what it came in for: every "Services" display fell back
        // to the literal "Walk-in service", and staff had to re-pick the same
        // services to raise the order. A walk-in now gets the same DRAFT order an
        // appointment produces, so the rest of the flow is identical from here on.
        const serviceOrder = await tx.serviceOrder.create({
          data: {
            serviceVisitId: serviceVisit.id,
            advisorUserId: userId,
            status: 'DRAFT',
            items: {
              create: uniqueCodes.map((code) => {
                const st = serviceTypeMap.get(code)!;
                return {
                  serviceTypeId: st.id,
                  estimateMinutes: st.baseDurationMinutes,
                };
              }),
            },
          },
          include: { items: { include: { serviceType: true } } },
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
        // Update vehicle color if provided
        if (data.color) {
          await tx.vehicle.update({
            where: { id: data.vehicleId },
            data: { color: data.color },
          });
        }

        return { serviceVisit, queueTicket, statusToken, serviceOrder };
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

    // CR-2026-084 — capture notification consent, mirroring the check-in path.
    // Only an actual change is written, and every change is audited.
    const optInUpdate: { notificationOptInSms?: boolean; notificationOptInEmail?: boolean } = {};
    if (
      data.notificationOptInSms !== undefined &&
      data.notificationOptInSms !== customer.notificationOptInSms
    ) {
      optInUpdate.notificationOptInSms = data.notificationOptInSms;
    }
    if (
      data.notificationOptInEmail !== undefined &&
      data.notificationOptInEmail !== customer.notificationOptInEmail
    ) {
      optInUpdate.notificationOptInEmail = data.notificationOptInEmail;
    }
    if (Object.keys(optInUpdate).length > 0) {
      const before = {
        notificationOptInSms: customer.notificationOptInSms,
        notificationOptInEmail: customer.notificationOptInEmail,
      };
      await this.prisma.customer.update({
        where: { id: data.customerId },
        data: optInUpdate,
      });
      await this.audit.log({
        actorUserId: userId,
        action: AUDIT_ACTIONS.CUSTOMER_NOTIFICATION_OPTIN,
        entityType: 'Customer',
        entityId: data.customerId,
        beforeJson: before,
        afterJson: { ...before, ...optInUpdate },
        reasonCode: 'WALKIN_CAPTURE',
        notes: 'Notification consent captured at walk-in registration',
      });
    }

    // CR-2026-084 — the auto-raised DRAFT order is a real status transition too.
    await this.statusHistory.record({
      entityType: 'ServiceOrder',
      entityId: result.serviceOrder.id,
      fromStatus: null,
      toStatus: 'DRAFT',
      changedByUserId: userId,
      reasonCode: 'WALK_IN_INTAKE',
      notes: 'Raised automatically from the services selected at walk-in registration',
    });

    this.logger.log(
      `[WALK_IN] Registered walk-in → ` +
        `ServiceVisit ${result.serviceVisit.id}, ` +
        `Ticket ${result.queueTicket.ticketNumber}, ` +
        `ServiceOrder ${result.serviceOrder.id} (${result.serviceOrder.items.length} item(s))`,
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
