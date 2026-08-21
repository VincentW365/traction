import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  calculateKpi,
  hasOverlap,
  type DelaySpan,
} from './engine/kpi-calculation';
import {
  detectPackage,
  isBenchmarked,
  type KpiPackageType,
  type PackageComponentMap,
} from './engine/package-detection';

/**
 * CR-2026-088 — the technician KPI framework.
 *
 * Reuses what already exists rather than building a parallel world:
 *  - `ServiceOrder.startedAt` is first-start-wins and is written in exactly one
 *    place, so it IS the "first Start Work" timestamp.
 *  - `ServiceOrder.completedAt` is stamped on entry to QC, so it IS "first Submit
 *    to QC".
 *  - The existing recording-only pause ledger keeps its meaning untouched. KPI
 *    exclusions are a SEPARATE ledger (`KpiDelayEvent`) that may link back to a
 *    pause, because a pause is a fact and an exclusion is a decision, and the two
 *    must not be conflated.
 *
 * Why the snapshot is taken at submit-to-QC and never recomputed from live rows:
 * `openRework()` nulls `startedAt` and `completedAt` so the next attempt times only
 * itself. If the KPI were derived on demand, a failed QC would silently erase the
 * first attempt's result — exactly the number the manager wants to keep.
 */
@Injectable()
export class KpiService {
  private readonly logger = new Logger(KpiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Policy + package resolution
  // -------------------------------------------------------------------------

  /** The policy in force now. Jobs snapshot this so later retunes never rewrite history. */
  async getActivePolicy(at: Date = new Date()) {
    const policy = await this.prisma.kpiPolicy.findFirst({
      where: {
        isActive: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { benchmarks: true },
    });
    return policy;
  }

  /** The administrator-configured serviceTypeId -> component map. */
  async getComponentMap(): Promise<PackageComponentMap> {
    const rows = await this.prisma.kpiServiceComponent.findMany({
      select: { serviceTypeId: true, component: true },
    });
    return new Map(rows.map((r) => [r.serviceTypeId, r.component as never]));
  }

  /** Classify a work order's services into a benchmark package. */
  async detectPackageForOrder(serviceOrderId: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: { items: { select: { serviceTypeId: true } } },
    });
    if (!order) throw new NotFoundException(`Service order ${serviceOrderId} not found`);

    const map = await this.getComponentMap();
    return detectPackage(
      order.items.map((i) => i.serviceTypeId),
      map,
    );
  }

  // -------------------------------------------------------------------------
  // The gate: KPI work needs a confirmed vehicle class
  // -------------------------------------------------------------------------

  /**
   * A vehicle with no confirmed class cannot be rated — there is no benchmark to
   * rate it against, and guessing would either flatter or punish the technician.
   * Called before a technician may start work.
   */
  async assertVehicleClassConfirmed(serviceOrderId: string): Promise<void> {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: {
        serviceVisit: {
          select: { vehicle: { select: { serviceClass: true, plateNumber: true } } },
        },
      },
    });
    const vehicle = order?.serviceVisit?.vehicle;
    if (!vehicle) return; // No vehicle on the visit — a different problem, not this gate.

    if (!vehicle.serviceClass || vehicle.serviceClass === 'UNKNOWN_REQUIRES_REVIEW') {
      throw new BadRequestException(
        `Confirm whether ${vehicle.plateNumber} is a Sedan or an SUV before starting work. ` +
          'The vehicle class sets the time standard this job is measured against.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * Freeze the KPI result for a job at the moment it is submitted to QC.
   *
   * Idempotent per order: a second call (a re-submit after rework) does NOT
   * overwrite the first attempt's numbers, it only flags that rework happened.
   */
  async captureSnapshotOnQc(serviceOrderId: string): Promise<void> {
    const existing = await this.prisma.workOrderKpiSnapshot.findUnique({
      where: { serviceOrderId },
    });
    if (existing) {
      // Second trip through QC — preserve the original completion result and record
      // that quality failed. Speed must not be improvable by reworking.
      if (!existing.hadRework) {
        await this.prisma.workOrderKpiSnapshot.update({
          where: { serviceOrderId },
          data: { hadRework: true },
        });
      }
      return;
    }

    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        items: { select: { serviceTypeId: true } },
        assignments: {
          select: { technicianId: true, isPrimary: true, endedAt: true, startedAt: true },
        },
        serviceVisit: {
          select: { vehicle: { select: { serviceClass: true } } },
        },
      },
    });
    if (!order) return;

    const policy = await this.getActivePolicy();
    if (!policy) {
      this.logger.warn(
        `No active KPI policy — cannot snapshot order ${serviceOrderId}. Run the seed.`,
      );
      return;
    }

    const componentMap = await this.getComponentMap();
    const detection = detectPackage(
      order.items.map((i) => i.serviceTypeId),
      componentMap,
    );

    const vehicleClass = order.serviceVisit?.vehicle?.serviceClass ?? null;
    const usableClass =
      vehicleClass && vehicleClass !== 'UNKNOWN_REQUIRES_REVIEW' ? vehicleClass : null;

    const benchmark =
      usableClass && isBenchmarked(detection.packageType)
        ? policy.benchmarks.find(
            (b) =>
              b.vehicleClass === usableClass && b.packageType === detection.packageType,
          )
        : undefined;

    const standardMinutes = benchmark?.standardMinutes ?? null;

    // Only APPROVED exclusions come out, and only those inside this attempt.
    const delays = await this.prisma.kpiDelayEvent.findMany({
      where: { serviceOrderId },
      select: {
        startedAt: true,
        endedAt: true,
        approvalStatus: true,
        requestedForExclusion: true,
      },
    });

    const result = calculateKpi({
      firstWorkStartedAt: order.startedAt,
      firstSubmittedToQcAt: order.completedAt,
      delays: delays as DelaySpan[],
      standardMinutes,
      absoluteBands: {
        excellentMaxMinutes: policy.absoluteExcellentMaxMinutes,
        meetsTargetMaxMinutes: policy.absoluteMeetsTargetMaxMinutes,
        needsImprovementMaxMinutes: policy.absoluteNeedsImprovementMaxMinutes,
      },
      adjustedTolerances: {
        meetsToleranceMinutes: policy.meetsToleranceMinutes,
        needsImprovementToleranceMinutes: policy.needsImprovementToleranceMinutes,
      },
    });

    const primary =
      order.assignments.find((a) => a.isPrimary) ?? order.assignments[0] ?? null;
    const distinctTechs = new Set(order.assignments.map((a) => a.technicianId));
    const isSharedOrReassigned = distinctTechs.size > 1;

    const { eligibilityStatus, eligibilityReason } = this.evaluateEligibility({
      vehicleClass: usableClass,
      packageType: detection.packageType,
      standardMinutes,
      hasPrimaryTechnician: !!primary,
      firstWorkStartedAt: order.startedAt,
      firstSubmittedToQcAt: order.completedAt,
      computedMinutes: result.kpiCompletionMinutes,
      detectionReason: detection.reason,
    });

    await this.prisma.workOrderKpiSnapshot.create({
      data: {
        serviceOrderId,
        policyId: policy.id,
        policyVersion: policy.version,
        vehicleClass: usableClass as never,
        packageType: detection.packageType as never,
        standardMinutes,
        firstWorkStartedAt: order.startedAt,
        firstSubmittedToQcAt: order.completedAt,
        rawElapsedMinutes: result.rawElapsedMinutes,
        approvedExcludedMinutes: result.approvedExcludedMinutes,
        kpiCompletionMinutes: result.kpiCompletionMinutes,
        varianceMinutes: result.varianceMinutes,
        variancePercent: result.variancePercent,
        absoluteCompletionRating: result.absoluteCompletionRating as never,
        // A job that is not formally eligible gets no adjusted rating, even if the
        // arithmetic produced one — a misleading rating is worse than none.
        adjustedTechnicianRating:
          eligibilityStatus === 'ELIGIBLE'
            ? (result.adjustedTechnicianRating as never)
            : null,
        onTarget: eligibilityStatus === 'ELIGIBLE' ? result.onTarget : false,
        eligibilityStatus: eligibilityStatus as never,
        eligibilityReason,
        primaryTechnicianId: primary?.technicianId ?? null,
        isSharedOrReassigned,
        finalisedAt: new Date(),
      },
    });

    this.logger.log(
      `KPI snapshot for order ${serviceOrderId}: ${detection.packageType}, ` +
        `standard ${standardMinutes ?? 'n/a'}m, actual ${result.kpiCompletionMinutes ?? 'n/a'}m, ` +
        `${eligibilityStatus}`,
    );
  }

  /** Why a job does or does not carry a formal adjusted rating. */
  private evaluateEligibility(input: {
    vehicleClass: string | null;
    packageType: KpiPackageType;
    standardMinutes: number | null;
    hasPrimaryTechnician: boolean;
    firstWorkStartedAt: Date | null;
    firstSubmittedToQcAt: Date | null;
    computedMinutes: number | null;
    detectionReason: string | null;
  }): { eligibilityStatus: string; eligibilityReason: string | null } {
    if (!input.firstWorkStartedAt || !input.firstSubmittedToQcAt) {
      return {
        eligibilityStatus: 'MISSING_TIMESTAMPS',
        eligibilityReason: 'The job has no recorded start and finish.',
      };
    }
    if (!input.vehicleClass) {
      return {
        eligibilityStatus: 'MISSING_VEHICLE_CLASS',
        eligibilityReason:
          'The vehicle was never confirmed as a Sedan or an SUV, so there is no standard to measure against.',
      };
    }
    if (!input.hasPrimaryTechnician) {
      return {
        eligibilityStatus: 'NO_PRIMARY_TECHNICIAN',
        eligibilityReason: 'No technician is recorded against this job.',
      };
    }
    if (input.standardMinutes == null) {
      return {
        eligibilityStatus: 'NOT_BENCHMARKED',
        eligibilityReason:
          input.detectionReason ??
          'This combination of services has no agreed standard time.',
      };
    }
    if (input.computedMinutes == null) {
      return {
        eligibilityStatus: 'INVALID_TIMER_DATA',
        eligibilityReason: 'The recorded times do not produce a usable duration.',
      };
    }
    return { eligibilityStatus: 'ELIGIBLE', eligibilityReason: null };
  }

  // -------------------------------------------------------------------------
  // Live view, for the technician card and dispatch board
  // -------------------------------------------------------------------------

  /** The in-flight KPI position for a job that has started but not reached QC. */
  async getLiveKpi(serviceOrderId: string, now: Date = new Date()) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: {
        startedAt: true,
        completedAt: true,
        items: { select: { serviceTypeId: true } },
        serviceVisit: { select: { vehicle: { select: { serviceClass: true } } } },
      },
    });
    if (!order) throw new NotFoundException(`Service order ${serviceOrderId} not found`);

    const [policy, componentMap, delays] = await Promise.all([
      this.getActivePolicy(now),
      this.getComponentMap(),
      this.prisma.kpiDelayEvent.findMany({
        where: { serviceOrderId },
        select: {
          startedAt: true,
          endedAt: true,
          approvalStatus: true,
          requestedForExclusion: true,
        },
      }),
    ]);

    const detection = detectPackage(
      order.items.map((i) => i.serviceTypeId),
      componentMap,
    );
    const vehicleClass = order.serviceVisit?.vehicle?.serviceClass ?? null;
    const usableClass =
      vehicleClass && vehicleClass !== 'UNKNOWN_REQUIRES_REVIEW' ? vehicleClass : null;

    const benchmark =
      policy && usableClass && isBenchmarked(detection.packageType)
        ? policy.benchmarks.find(
            (b) => b.vehicleClass === usableClass && b.packageType === detection.packageType,
          )
        : undefined;

    const result = calculateKpi({
      firstWorkStartedAt: order.startedAt,
      firstSubmittedToQcAt: order.completedAt,
      delays: delays as DelaySpan[],
      standardMinutes: benchmark?.standardMinutes ?? null,
      absoluteBands: policy
        ? {
            excellentMaxMinutes: policy.absoluteExcellentMaxMinutes,
            meetsTargetMaxMinutes: policy.absoluteMeetsTargetMaxMinutes,
            needsImprovementMaxMinutes: policy.absoluteNeedsImprovementMaxMinutes,
          }
        : undefined,
      adjustedTolerances: policy
        ? {
            meetsToleranceMinutes: policy.meetsToleranceMinutes,
            needsImprovementToleranceMinutes: policy.needsImprovementToleranceMinutes,
          }
        : undefined,
      now,
    });

    return {
      vehicleClass: usableClass,
      packageType: detection.packageType,
      packageReason: detection.reason,
      standardMinutes: benchmark?.standardMinutes ?? null,
      minutesRemaining:
        benchmark && result.kpiCompletionMinutes != null
          ? benchmark.standardMinutes - result.kpiCompletionMinutes
          : null,
      ...result,
    };
  }

  // -------------------------------------------------------------------------
  // Delay events
  // -------------------------------------------------------------------------

  /**
   * Record a delay. A technician may raise one and may ask for it to be excluded,
   * but the request stays PENDING until a supervisor decides — a technician
   * approving their own exclusion would make the whole measure self-reported.
   */
  async recordDelay(input: {
    serviceOrderId: string;
    technicianId?: string | null;
    reasonCode: string;
    description?: string;
    startedAt: Date;
    endedAt?: Date | null;
    requestedForExclusion?: boolean;
    recordedByUserId: string;
    serviceOrderPauseId?: string | null;
  }) {
    if (input.endedAt && input.endedAt <= input.startedAt) {
      throw new BadRequestException('A delay must end after it starts.');
    }

    // Refuse a delay that overlaps one already recorded — overlapping exclusions
    // would let the same twenty minutes be deducted twice.
    const siblings = await this.prisma.kpiDelayEvent.findMany({
      where: { serviceOrderId: input.serviceOrderId },
      select: { startedAt: true, endedAt: true },
    });
    const candidate = { startedAt: input.startedAt, endedAt: input.endedAt ?? null };
    if (hasOverlap([...siblings, candidate])) {
      throw new BadRequestException(
        'That delay overlaps one already recorded on this job.',
      );
    }

    const durationMinutes = input.endedAt
      ? Math.ceil((input.endedAt.getTime() - input.startedAt.getTime()) / 60_000)
      : null;

    const created = await this.prisma.kpiDelayEvent.create({
      data: {
        serviceOrderId: input.serviceOrderId,
        technicianId: input.technicianId ?? null,
        reasonCode: input.reasonCode as never,
        description: input.description ?? null,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        durationMinutes,
        requestedForExclusion: input.requestedForExclusion ?? false,
        approvalStatus: 'PENDING',
        recordedByUserId: input.recordedByUserId,
        serviceOrderPauseId: input.serviceOrderPauseId ?? null,
      },
    });

    await this.audit.log({
      actorUserId: input.recordedByUserId,
      action: 'KPI_DELAY_RECORDED',
      entityType: 'KpiDelayEvent',
      entityId: created.id,
      afterJson: {
        serviceOrderId: input.serviceOrderId,
        reasonCode: input.reasonCode,
        durationMinutes,
        requestedForExclusion: created.requestedForExclusion,
      },
      reasonCode: input.reasonCode,
      notes: input.description,
    });

    return created;
  }

  /**
   * Approve or reject an exclusion request.
   *
   * The approver may not be the technician the delay belongs to. Without that, the
   * exclusion is self-reported and the KPI measures honesty rather than work.
   */
  async decideDelay(input: {
    delayId: string;
    approve: boolean;
    actorUserId: string;
    rejectionReason?: string;
  }) {
    const delay = await this.prisma.kpiDelayEvent.findUnique({
      where: { id: input.delayId },
    });
    if (!delay) throw new NotFoundException('Delay not found');
    if (delay.approvalStatus !== 'PENDING') {
      throw new BadRequestException(
        `This delay has already been ${delay.approvalStatus.toLowerCase()}.`,
      );
    }
    if (!delay.requestedForExclusion) {
      throw new BadRequestException(
        'This delay was recorded for the record only; it was not submitted for KPI exclusion.',
      );
    }
    if (!delay.endedAt) {
      throw new BadRequestException('The delay is still open — it cannot be approved yet.');
    }

    const actorTech = await this.prisma.technician.findUnique({
      where: { userAccountId: input.actorUserId },
      select: { id: true },
    });
    if (actorTech && actorTech.id === delay.technicianId) {
      throw new ForbiddenException(
        'You cannot approve your own KPI exclusion. A supervisor must review it.',
      );
    }
    if (!input.approve && !input.rejectionReason?.trim()) {
      throw new BadRequestException('A reason is required to reject an exclusion.');
    }

    const updated = await this.prisma.kpiDelayEvent.update({
      where: { id: input.delayId },
      data: {
        approvalStatus: input.approve ? 'APPROVED' : 'REJECTED',
        approvedByUserId: input.actorUserId,
        approvedAt: new Date(),
        rejectionReason: input.approve ? null : input.rejectionReason!.trim(),
      },
    });

    await this.audit.log({
      actorUserId: input.actorUserId,
      action: input.approve ? 'KPI_DELAY_APPROVED' : 'KPI_DELAY_REJECTED',
      entityType: 'KpiDelayEvent',
      entityId: updated.id,
      beforeJson: { approvalStatus: 'PENDING' },
      afterJson: {
        approvalStatus: updated.approvalStatus,
        durationMinutes: updated.durationMinutes,
      },
      reasonCode: updated.reasonCode,
      notes: input.rejectionReason,
    });

    return updated;
  }

  /** Close an open delay. */
  async endDelay(delayId: string, actorUserId: string, endedAt: Date = new Date()) {
    const delay = await this.prisma.kpiDelayEvent.findUnique({ where: { id: delayId } });
    if (!delay) throw new NotFoundException('Delay not found');
    if (delay.endedAt) throw new BadRequestException('That delay is already closed.');
    if (endedAt <= delay.startedAt) {
      throw new BadRequestException('A delay must end after it starts.');
    }

    return this.prisma.kpiDelayEvent.update({
      where: { id: delayId },
      data: {
        endedAt,
        durationMinutes: Math.ceil(
          (endedAt.getTime() - delay.startedAt.getTime()) / 60_000,
        ),
      },
    });
  }

  async listDelays(serviceOrderId: string) {
    return this.prisma.kpiDelayEvent.findMany({
      where: { serviceOrderId },
      orderBy: { startedAt: 'asc' },
    });
  }
}
