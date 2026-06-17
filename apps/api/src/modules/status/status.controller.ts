import { Controller, Get, Patch, Param, Body, NotFoundException, BadRequestException, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertMileageGate } from '../../common/helpers/mileage-gate';

/**
 * Public customer status endpoint — NO authentication required.
 * Accessed via token URL given at check-in.
 */
@ApiTags('Customer Status')
@Controller('status')
export class StatusController {
  constructor(private prisma: PrismaService) {}

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
        queueTicket: { select: { ticketNumber: true, queueRank: true, displayStatus: true } },
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

    // CR-2026-028: queue-position context (no ETA). Count the ranked line at this site.
    const totalInQueue = position !== null
      ? await this.prisma.queueTicket.count({
          where: { serviceVisit: { siteId: visit.siteId }, queueRank: { not: null } },
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

    // Determine estimated wait text based on position and status
    const estimatedWait = this.getEstimatedWaitText(displayStatus, position, partsReadiness);

    // Status progression
    const statusProgression = ['CHECKED_IN', 'IN_QUEUE', 'CALLED', 'IN_SERVICE', 'READY_FOR_PICKUP'];
    const currentStep = this.getCurrentStep(displayStatus, visit.status);

    return {
      ticketNumber: ticket?.ticketNumber ?? null,
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
    // Terminal/active states
    if (displayStatus === 'COMPLETED' || displayStatus === 'CANCELLED') {
      return 'Visit complete.';
    }
    if (['READY_FOR_PICKUP', 'QC'].includes(displayStatus)) {
      return 'Your vehicle is ready for pickup!';
    }
    if (displayStatus === 'IN_SERVICE') {
      return 'Work is in progress on your vehicle.';
    }
    if (displayStatus === 'CALLED') {
      return 'You have been called — please proceed to the service area.';
    }

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

  private getCurrentStep(displayStatus: string, visitStatus: string): number {
    // Map to progression: 0=CHECKED_IN, 1=IN_QUEUE, 2=CALLED, 3=IN_SERVICE, 4=READY_FOR_PICKUP
    const status = displayStatus || visitStatus;
    if (['READY_FOR_PICKUP', 'QC', 'CLOSED'].includes(status)) return 4;
    if (status === 'IN_SERVICE') return 3;
    if (status === 'CALLED') return 2;
    if (['WAITING', 'BLOCKED', 'PENDING_RANK', 'QUEUED'].includes(status)) return 1;
    return 0; // CHECKED_IN
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
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Patch(':id/completion')
  @RequirePermission(PERMISSIONS.CHECKIN_PERFORM)
  @ApiOperation({ summary: 'Record completion data (mileage out, oil installed)' })
  async recordCompletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      mileageOut?: number;
      oilBrandInstalled?: string;
      oilGradeInstalled?: string;
      mileageOverride?: boolean;
      overrideReason?: string;
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

    // DMAIC Rule 5: mileage gate (bidirectional + manager override) on mileageOut.
    const requiresMileage =
      (visit.appointment?.services ?? []).some((s) => s.serviceType.requiresMileage === true) ||
      (visit.serviceOrders ?? []).some((so) => so.items.some((i) => i.serviceType.requiresMileage === true));
    const mileageProvided = body.mileageOut != null;
    const mileageOverride = body.mileageOverride === true;
    assertMileageGate({ requiresMileage, mileageProvided, override: mileageOverride });

    const gateWouldBlock =
      (requiresMileage && !mileageProvided) || (!requiresMileage && mileageProvided);
    if (mileageOverride && gateWouldBlock) {
      await this.audit.log({
        actorUserId: user.sub,
        action: AUDIT_ACTIONS.MILEAGE_GATE_OVERRIDE,
        entityType: 'ServiceVisit',
        entityId: id,
        afterJson: { requiresMileage, mileageProvided, mileageOut: body.mileageOut ?? null, boundary: 'COMPLETION' },
        reasonCode: 'MILEAGE_GATE_OVERRIDE',
        notes: body.overrideReason,
      });
    }

    // Validate mileage out >= mileage in
    if (body.mileageOut != null && visit.mileageIn != null) {
      if (body.mileageOut < visit.mileageIn) {
        throw new BadRequestException(
          `Mileage out (${body.mileageOut}) cannot be less than mileage in (${visit.mileageIn})`,
        );
      }
    }

    // P4(c) GOV-005: vehicle-release payment gate. Releasing (status -> CLOSED)
    // is blocked unless every service order's payment is cleared, OR a manager
    // records an audited exception. Cleared = PAID / ON_ACCOUNT / WAIVED.
    const PAYMENT_CLEARED = ['PAID', 'ON_ACCOUNT', 'WAIVED'];
    const unpaidOrders = (visit.serviceOrders ?? []).filter(
      (so) => !PAYMENT_CLEARED.includes(so.paymentStatus),
    );
    if (unpaidOrders.length > 0) {
      if (body.paymentReleaseOverride !== true) {
        throw new BadRequestException(
          'Cannot release vehicle: payment is not cleared. A manager exception is required.',
        );
      }
      if (!['ADMIN'].includes(user.role)) {
        throw new BadRequestException(
          'Only a manager or admin can authorize a payment-release exception.',
        );
      }
      if (!body.paymentReleaseOverrideReason?.trim()) {
        throw new BadRequestException(
          'A reason is required to authorize a payment-release exception.',
        );
      }
      await this.audit.log({
        actorUserId: user.sub,
        action: AUDIT_ACTIONS.PAYMENT_RELEASE_OVERRIDE,
        entityType: 'ServiceVisit',
        entityId: id,
        beforeJson: {
          unpaidOrders: unpaidOrders.map((o) => ({ id: o.id, paymentStatus: o.paymentStatus })),
        },
        afterJson: { released: true },
        reasonCode: 'PAYMENT_RELEASE_OVERRIDE',
        notes: body.paymentReleaseOverrideReason,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const sv = await tx.serviceVisit.update({
        where: { id },
        data: {
          mileageOut: body.mileageOut ?? undefined,
          oilBrandInstalled: body.oilBrandInstalled ?? undefined,
          oilGradeInstalled: body.oilGradeInstalled ?? undefined,
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

      return sv;
    });

    return { message: 'Visit completion recorded', serviceVisitId: updated.id };
  }
}
