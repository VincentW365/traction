import { Controller, Get, Post, Patch, Put, Param, Body, NotFoundException, BadRequestException, UseGuards, ParseUUIDPipe, Optional, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EtaService } from '../scheduling/eta/eta.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { ETA_PRESENTATION_DEFAULTS } from '../scheduling/eta/eta.config';
import { presentEta, toPublicEta } from '../../common/helpers/eta-presentation';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { TERMINAL_VISIT_STATUSES } from '../../common/helpers/operational-scope';

/**
 * Public customer status endpoint — NO authentication required.
 * Accessed via token URL given at check-in.
 */
@ApiTags('Customer Status')
@Controller('status')
export class StatusController {
  constructor(
    private prisma: PrismaService,
    // CR-2026-105b — optional so the existing controller specs keep constructing
    // it with a bare prisma; falls back to the documented presentation defaults.
    @Optional() private eta?: EtaService,
  ) {}

  @Get(':token')
  @ApiOperation({ summary: 'Get customer visit status (public, no auth)' })
  async getStatus(@Param('token') token: string) {
    const now = new Date();

    const visit = await this.prisma.serviceVisit.findFirst({
      where: {
        customerStatusToken: token,
        tokenExpiresAt: { gt: now },
      },
      include: {
        vehicle: { select: { plateNumber: true } },
        queueTicket: {
          select: {
            ticketNumber: true,
            // CR-2026-089 — the customer reads the short number, e.g. B01-003.
            displayTicketNumber: true,
            queueRank: true,
            displayStatus: true,
            lastRankedAt: true,
          },
        },
        appointment: {
          include: { services: { include: { serviceType: { select: { name: true } } } } },
        },
        serviceOrders: {
          include: { items: { include: { serviceType: { select: { name: true } } } } },
        },
      },
    });

    if (!visit) {
      throw new NotFoundException('This link has expired or is invalid. Please contact the front desk.');
    }

    const ticket = visit.queueTicket;
    const position = ticket?.queueRank ?? null;
    const displayStatus = ticket?.displayStatus ?? visit.status;
    const partsReadiness = visit.partsReadiness;

    // CR-2026-028: queue-position context (no ETA). Count the ranked line at this
    // site. CR-2026-098c — only tickets whose VISIT is still operationally open:
    // a stale ticket under a closed visit once told a customer they were
    // "#1 of 6" in an empty shop.
    const totalInQueue = position !== null
      ? await this.prisma.queueTicket.count({
          where: {
            serviceVisit: { siteId: visit.siteId, status: { notIn: [...TERMINAL_VISIT_STATUSES] } },
            queueRank: { not: null },
          },
        })
      : 0;
    const aheadCount = position !== null ? Math.max(0, position - 1) : null;
    const behindCount = position !== null ? Math.max(0, totalInQueue - position) : null;

    // Gather services from appointment or service orders
    const services = [
      ...(visit.appointment?.services?.map((s) => s.serviceType.name) ?? []),
      ...(visit.serviceOrders?.flatMap((so) => so.items.map((i) => i.serviceType.name)) ?? []),
    ];
    const uniqueServices = [...new Set(services)];

    // Mask plate: show only last 4 characters
    const plate = visit.vehicle?.plateNumber ?? '';
    const maskedPlate = plate.length > 4
      ? '***' + plate.slice(-4)
      : plate;

    // CR-2026-084 — the ticket and the visit each know part of the story, and the
    // ticket cannot express QC or "ready for pickup" at all. Take whichever is
    // further along so a finished car never reads as still being worked on.
    const effectiveStatus =
      this.stepOf(visit.status) > this.stepOf(displayStatus) ? visit.status : displayStatus;

    // Determine estimated wait text based on position and status
    const estimatedWait = this.getEstimatedWaitText(effectiveStatus, position, partsReadiness);

    // Status progression — "Called" removed (internal dispatch state, see stepOf).
    const statusProgression = ['CHECKED_IN', 'IN_QUEUE', 'IN_SERVICE', 'READY_FOR_PICKUP'];
    const currentStep = this.getCurrentStep(displayStatus, visit.status);

    // CR-2026-105b — the same persisted estimate the lobby screen shows, in the
    // public-safe shape (times + ON_TIME/DELAYED; no internal reasons).
    let etaCfg = ETA_PRESENTATION_DEFAULTS;
    if (this.eta) {
      try {
        etaCfg = await this.eta.loadRules(visit.siteId);
      } catch {
        etaCfg = ETA_PRESENTATION_DEFAULTS;
      }
    }
    const eta = toPublicEta(
      presentEta({
        now,
        visitStatus: visit.status,
        queueRank: ticket?.queueRank ?? null,
        orderStatuses: (visit.serviceOrders ?? []).map((o) => o.status),
        promisedCompletionAt: (visit.serviceOrders ?? []).find((o) => o.promisedCompletionAt)?.promisedCompletionAt ?? null,
        scheduledStartAt: visit.appointment?.scheduledStartAt ?? null,
        currentEtaStartAt: visit.currentEtaStartAt,
        currentEtaCompleteAt: visit.currentEtaCompleteAt,
        lastUpdatedAt: ticket?.lastRankedAt ?? null,
        config: etaCfg,
      }),
    );

    return {
      eta,
      // CR-2026-089 — short number for the customer; legacy tickets keep theirs.
      ticketNumber: ticket?.displayTicketNumber ?? ticket?.ticketNumber ?? null,
      position,
      totalInQueue,
      aheadCount,
      behindCount,
      status: displayStatus,
      partsReadiness,
      estimatedWait,
      services: uniqueServices.length > 0 ? uniqueServices : ['Service in progress'],
      vehiclePlate: maskedPlate,
      statusProgression,
      currentStep,
    };
  }

  private getEstimatedWaitText(
    displayStatus: string,
    position: number | null,
    partsReadiness: string,
  ): string {
    // Terminal/active states. CR-2026-084 — CLOSED and ABANDONED included: a closed
    // visit used to fall through every branch and tell the customer "You're in line
    // — we'll update you soon." after their car had already been collected.
    if (['COMPLETED', 'CANCELLED', 'CLOSED', 'ABANDONED'].includes(displayStatus)) {
      return 'Visit complete.';
    }
    if (displayStatus === 'READY_FOR_PICKUP') {
      return 'Your vehicle is ready for pickup!';
    }
    // CR-2026-084 — QC is a final check, not collection. Announcing "ready" here
    // sent customers to the counter before the work had been signed off.
    if (displayStatus === 'QC') {
      return 'Work is complete — we are carrying out a final quality check.';
    }
    if (displayStatus === 'IN_SERVICE') {
      return 'Work is in progress on your vehicle.';
    }
    // CR-2026-084 — CALLED is an internal dispatch state. The customer handed the
    // car over at check-in, so telling them to "proceed to the service area" was
    // wrong; from their side they are simply still waiting.

    // Blocked
    if (displayStatus === 'BLOCKED' || partsReadiness === 'REQUIRED_NOT_READY') {
      return "We're getting your parts ready. You'll keep your place in line.";
    }

    // In queue (CR-2026-028: friendly tier, no time; exact position shown separately)
    if (position !== null) {
      if (position <= 1) return "You're next in line!";
      if (position <= 3) return "You're near the front of the line.";
      return "You're in the queue.";
    }

    return "You're in line — we'll update you soon.";
  }

  /**
   * CR-2026-084 — the customer-facing progress step.
   *
   * "Called" was dropped from the progression. It is an internal dispatch state
   * (a bay has been claimed) that happens after the customer has already handed
   * the car over, so it told them nothing and the old copy — "please proceed to
   * the service area" — actively misled them.
   *
   * The step is now the FURTHEST of the ticket's and the visit's own status rather
   * than blindly preferring the ticket. QueueDisplayStatus has no member for QC or
   * "ready for pickup", so a ticket sits at IN_SERVICE while the visit moves ahead;
   * preferring the ticket pinned finished cars at "In Service".
   */
  private getCurrentStep(displayStatus: string, visitStatus: string): number {
    return Math.max(this.stepOf(displayStatus), this.stepOf(visitStatus));
  }

  /** Progression: 0=CHECKED_IN, 1=IN_QUEUE, 2=IN_SERVICE, 3=READY_FOR_PICKUP. */
  private stepOf(status: string | null | undefined): number {
    if (!status) return 0;
    if (['READY_FOR_PICKUP', 'CLOSED', 'COMPLETED'].includes(status)) return 3;
    // CR-2026-084 — QC is NOT "ready". A car awaiting quality sign-off used to tell
    // the customer their vehicle was ready for pickup; if it then failed QC the bar
    // visibly ran backwards from "Ready" to "In Queue" and the customer may already
    // have set out to collect it. Work in QC is still work in progress.
    if (['IN_SERVICE', 'QC'].includes(status)) return 2;
    // CALLED means a bay was claimed; from the customer's side they are still waiting.
    if (['WAITING', 'BLOCKED', 'PENDING_RANK', 'QUEUED', 'ISSUED', 'CALLED'].includes(status)) {
      return 1;
    }
    return 0; // CHECKED_IN / ARRIVED / CREATED
  }
}

/**
 * Service Visit completion endpoint — records mileage out, oil installed.
 * Used by front desk after technician marks work complete.
 */
@ApiTags('Service Visits')
@Controller('service-visits')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ServiceVisitCompletionController {
  private readonly logger = new Logger(ServiceVisitCompletionController.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    // CR-2026-105b — closing a visit frees a service position; republish estimates.
    @Optional() private scheduling?: SchedulingService,
  ) {}

  private async republishEstimates(siteId: string): Promise<void> {
    if (!this.scheduling) return;
    try {
      await this.scheduling.recomputeQueue(siteId);
    } catch (err) {
      this.logger.error(`Queue recompute after close-out failed for site ${siteId}: ${(err as Error).message}`);
    }
  }

  /**
   * CR-2026-093 — everything the job sheet needs, in one read.
   *
   * The sheet is filled from data the system already holds; nobody retypes a
   * chassis number that was captured at check-in. QUEUE_VIEW so technicians can
   * open the sheet for the vehicle in front of them.
   */
  @Get(':id/job-sheet')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Data for the Service Centre job sheet: customer, vehicle, services, ticket' })
  async jobSheet(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id },
      select: {
        id: true,
        siteId: true,
        visitNumber: true, // CR-2026-097 — the job sheet's number derives from this (JS-<visit>)
        mileageIn: true,
        createdAt: true,
        customer: {
          select: { customerNumber: true, firstName: true, lastName: true, phone: true, email: true },
        },
        vehicle: {
          select: {
            plateNumber: true, make: true, model: true, modelYear: true,
            engineNo: true, vin: true, fuelType: true, transmission: true, drivetrain: true,
            // CR-2026-100 §10 — the authoritative vehicle type flows onto the sheet.
            serviceClass: true,
          },
        },
        queueTicket: { select: { ticketNumber: true } },
        serviceOrders: {
          select: {
            id: true,
            notes: true,
            items: { select: { serviceType: { select: { code: true, name: true } } } },
            assignments: {
              where: { isPrimary: true },
              select: { technician: { select: { userAccount: { select: { fullName: true } } } } },
            },
          },
        },
        // CR-2026-111 §5/§13 — what the CUSTOMER asked for, kept distinct from
        // what staff concluded. The sheet used to show only `serviceOrders.notes`,
        // which is a staff directive, so the sentence the customer actually wrote
        // never reached the person holding the clipboard and an advisor retyped it.
        //
        // Read from the appointment's intake where there is one, and fall back to
        // the CUSTOMER_CONCERN visit note for bookings taken before it existed.
        appointment: {
          select: {
            sourceChannel: true,
            customerReportedMileage: true,
            services: {
              select: { serviceType: { select: { code: true, name: true, customerFacingName: true } } },
            },
            bookingIntake: {
              select: { category: true, customerConcern: true, symptoms: true, additionalComments: true, createdAt: true },
            },
          },
        },
        visitNotes: {
          where: { kind: 'CUSTOMER_CONCERN' },
          orderBy: { createdAt: 'asc' },
          select: { text: true, createdAt: true, authorRole: true },
        },
        // The saved sheet, when one exists — the page restores it over the prefill.
        jobSheetDraft: {
          select: { data: true, signatureImage: true, updatedAt: true },
        },
      },
    });
    if (!visit) throw new NotFoundException(`ServiceVisit ${id} not found`);
    if (user.role !== 'ADMIN' && user.siteId !== visit.siteId) {
      throw new NotFoundException(`ServiceVisit ${id} not found`);
    }
    return visit;
  }

  /**
   * CR-2026-093 — save the sheet as filled.
   *
   * Upsert of one document per visit: whoever saves last owns the sheet, which
   * matches how the paper card works on a clipboard. The audit entry records who
   * and when, never the signature image itself.
   */
  @Put(':id/job-sheet-draft')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Save the filled job sheet for a visit (fields, ticks, directive, signature)' })
  async saveJobSheetDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { data?: Record<string, unknown>; signatureImage?: string | null },
    @CurrentUser() user: JwtPayload,
  ) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id },
      select: { id: true, siteId: true },
    });
    if (!visit) throw new NotFoundException(`ServiceVisit ${id} not found`);
    if (user.role !== 'ADMIN' && user.siteId !== visit.siteId) {
      throw new NotFoundException(`ServiceVisit ${id} not found`);
    }
    if (!body?.data || typeof body.data !== 'object') {
      throw new BadRequestException('Nothing to save.');
    }
    if (body.signatureImage && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(body.signatureImage)) {
      throw new BadRequestException('The signature payload is not a valid image.');
    }
    if (body.signatureImage && body.signatureImage.length > 500_000) {
      throw new BadRequestException('The signature image is unexpectedly large — clear and redraw it.');
    }

    const draft = await this.prisma.jobSheetDraft.upsert({
      where: { serviceVisitId: id },
      update: {
        data: body.data as never,
        signatureImage: body.signatureImage ?? null,
        updatedByUserId: user.sub,
      },
      create: {
        serviceVisitId: id,
        data: body.data as never,
        signatureImage: body.signatureImage ?? null,
        updatedByUserId: user.sub,
      },
      select: { updatedAt: true },
    });

    await this.audit.log({
      actorUserId: user.sub,
      action: 'JOB_SHEET_SAVED',
      entityType: 'ServiceVisit',
      entityId: id,
      afterJson: { hasSignature: !!body.signatureImage },
      notes: 'Job sheet draft saved',
    });
    return { saved: true, updatedAt: draft.updatedAt };
  }

  @Patch(':id/completion')
  @RequirePermission(PERMISSIONS.CHECKIN_PERFORM)
  @ApiOperation({ summary: 'Record completion data (mileage out, oil installed)' })
  async recordCompletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      mileageOut?: number;
      oilBrandInstalled?: string;
      oilGradeInstalled?: string;
      notes?: string;
      paymentReleaseOverride?: boolean;
      paymentReleaseOverrideReason?: string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id },
      include: {
        vehicle: true,
        appointment: { include: { services: { include: { serviceType: { select: { requiresMileage: true } } } } } },
        serviceOrders: { include: { items: { include: { serviceType: { select: { requiresMileage: true } } } } } },
      },
    });

    if (!visit) throw new NotFoundException(`ServiceVisit ${id} not found`);

    // CR-2026-072 — mileage is optional at completion (no required-mileage gate here).
    // If a value IS provided it must still be >= mileage in (data sanity, below).

    // Validate mileage out >= mileage in
    if (body.mileageOut != null && visit.mileageIn != null) {
      if (body.mileageOut < visit.mileageIn) {
        throw new BadRequestException(
          `Mileage out (${body.mileageOut}) cannot be less than mileage in (${visit.mileageIn})`,
        );
      }
    }

    // CR-2026-085 — GOV-005's vehicle-release payment gate was REMOVED at the
    // owner's direction. Payment is settled in the external POS, not in Traction,
    // so blocking close-out here stalled the front desk on a status this system is
    // not the source of truth for. Closing a visit is now purely operational.
    //
    // Payment state is still RECORDED on each ServiceOrder and still reportable —
    // it simply no longer gates release. Re-introducing a gate is a business-rule
    // decision (docs/03_Business_Rules.md, GOV-005), not a code tweak.
    const PAYMENT_CLEARED = ['PAID', 'ON_ACCOUNT', 'WAIVED'];
    const unpaidOrders = (visit.serviceOrders ?? []).filter(
      (so) => !PAYMENT_CLEARED.includes(so.paymentStatus),
    );
    if (unpaidOrders.length > 0) {
      // Not a block — an audit breadcrumb, so "released before payment cleared"
      // remains answerable after the fact.
      await this.audit.log({
        actorUserId: user.sub,
        action: AUDIT_ACTIONS.PAYMENT_RELEASE_OVERRIDE,
        entityType: 'ServiceVisit',
        entityId: id,
        beforeJson: {
          unpaidOrders: unpaidOrders.map((o) => ({ id: o.id, paymentStatus: o.paymentStatus })),
        },
        afterJson: { released: true, gateEnforced: false },
        reasonCode: 'RELEASED_PAYMENT_NOT_CLEARED',
        notes:
          body.paymentReleaseOverrideReason?.trim() ||
          'Visit closed with payment not cleared (payment gate disabled — settled in the external POS).',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // CR-2026-072 — completion notes are optional; append to any existing visit notes.
      const noteText = body.notes?.trim();
      const mergedNotes = noteText
        ? visit.notes
          ? `${visit.notes}\n${noteText}`
          : noteText
        : undefined;

      const sv = await tx.serviceVisit.update({
        where: { id },
        data: {
          mileageOut: body.mileageOut ?? undefined,
          oilBrandInstalled: body.oilBrandInstalled ?? undefined,
          oilGradeInstalled: body.oilGradeInstalled ?? undefined,
          ...(mergedNotes !== undefined && { notes: mergedNotes }),
          status: 'CLOSED',
        },
      });

      // Update vehicle odometer to mileage out
      if (body.mileageOut && visit.vehicleId) {
        await tx.vehicle.update({
          where: { id: visit.vehicleId },
          data: { odometer: body.mileageOut },
        });
      }

      // CR-2026-075 — closing the visit frees any dispatch-board bay it still holds, so
      // the board never shows a closed visit occupying a resource.
      await tx.resourceOccupancy.updateMany({
        where: { serviceVisitId: id, status: 'OCCUPIED' },
        data: { status: 'AVAILABLE', serviceVisitId: null, technicianId: null },
      });

      // CR-2026-084 — close the queue ticket too. The one-click "Picked Up" path
      // already did this, but this fuller close-out did not: the visit went CLOSED
      // while its ticket was left reading IN_SERVICE forever. It fell off the board
      // (which filters on visit status) but stayed permanently wrong in the data,
      // and any view keyed on the ticket still saw a live job.
      await tx.queueTicket.updateMany({
        where: { serviceVisitId: id, displayStatus: { notIn: ['COMPLETED', 'CANCELLED'] } },
        data: { displayStatus: 'COMPLETED', queueRank: null, readyForDispatch: false },
      });

      return sv;
    });

    await this.republishEstimates(updated.siteId);

    return { message: 'Visit completion recorded', serviceVisitId: updated.id };
  }

  // ---------------------------------------------------------------------------
  // CR-2026-063 — parts awareness acknowledgement.
  // Actual parts ordering happens in a separate app; Traction only records that
  // staff acknowledged the parts are arranged/prepositioned. Stored as an audit
  // event (no schema change), readable as a current-state flag.
  // ---------------------------------------------------------------------------

  @Post(':id/acknowledge-parts')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Acknowledge (or clear) that parts are prepositioned for this visit' })
  async acknowledgeParts(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { acknowledged?: boolean; note?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const visit = await this.prisma.serviceVisit.findUnique({ where: { id }, select: { id: true } });
    if (!visit) throw new NotFoundException(`ServiceVisit ${id} not found`);

    const clearing = body.acknowledged === false;
    await this.audit.log({
      actorUserId: user.sub,
      action: clearing ? AUDIT_ACTIONS.PARTS_ACK_CLEARED : AUDIT_ACTIONS.PARTS_ACK_APPLIED,
      entityType: 'ServiceVisit',
      entityId: id,
      notes: body.note,
    });
    return this.readPartsAck(id);
  }

  @Get(':id/parts-ack')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Current parts-prepositioned acknowledgement state for a visit' })
  async getPartsAck(@Param('id', ParseUUIDPipe) id: string) {
    return this.readPartsAck(id);
  }

  private async readPartsAck(id: string) {
    const latest = await this.audit.findLatest('ServiceVisit', id, [
      AUDIT_ACTIONS.PARTS_ACK_APPLIED,
      AUDIT_ACTIONS.PARTS_ACK_CLEARED,
    ]);
    const acknowledged = latest?.action === AUDIT_ACTIONS.PARTS_ACK_APPLIED;
    return {
      acknowledged,
      at: acknowledged ? latest?.createdAt ?? null : null,
      by: acknowledged ? latest?.actor?.fullName ?? null : null,
    };
  }
}
