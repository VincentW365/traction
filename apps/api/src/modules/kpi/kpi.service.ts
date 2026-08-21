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
  type PackageDetectionOptions,
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

  /**
   * The administrator-configured serviceTypeId -> mapping.
   *
   * Only ACTIVE, currently-effective rows. Superseded mappings stay in the table on
   * purpose — completed snapshots were produced under them and must remain
   * explicable — but they must never influence a job being classified today.
   */
  async getComponentMap(at: Date = new Date()): Promise<PackageComponentMap> {
    const rows = await this.prisma.kpiServiceComponent.findMany({
      where: {
        isActive: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      select: {
        serviceTypeId: true,
        componentRole: true,
        requiresAxleQualifier: true,
      },
    });
    return new Map(
      rows.map((r) => [
        r.serviceTypeId,
        {
          componentRole: r.componentRole as never,
          requiresAxleQualifier: r.requiresAxleQualifier,
        },
      ]),
    );
  }

  /**
   * Whether management has approved front-and-rear brake jobs to use the Front
   * Brakes standard. Configuration, not a constant: a job covering both axles is
   * more work than that standard was built for, so the default is no.
   */
  async getFrontAndRearApproval(at: Date = new Date()): Promise<boolean> {
    const rule = await this.prisma.businessRuleConfig.findFirst({
      where: {
        ruleKey: 'kpi_front_and_rear_satisfies_front_brakes',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    return (rule?.valueJson as boolean) ?? false;
  }

  /** Service lines in the shape detection needs, including the axle qualifier. */
  private async detectionOptions(): Promise<PackageDetectionOptions> {
    return { frontAndRearSatisfiesFrontBrakes: await this.getFrontAndRearApproval() };
  }

  /** Classify a work order's services into a benchmark package. */
  async detectPackageForOrder(serviceOrderId: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: { items: { select: { serviceTypeId: true, axlePosition: true } } },
    });
    if (!order) throw new NotFoundException(`Service order ${serviceOrderId} not found`);

    const [map, options] = await Promise.all([
      this.getComponentMap(),
      this.detectionOptions(),
    ]);
    return detectPackage(order.items as never, map, options);
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
   * Open the snapshot when work starts, capturing the terms the job will be judged
   * against: policy version, vehicle class, package and standard.
   *
   * Taken here rather than only at the end so the terms are fixed BEFORE the
   * outcome is known. A benchmark chosen after seeing a poor result is not a
   * benchmark. It also gives the technician's card and the dispatch board a
   * standard to count down against while the job is running.
   *
   * Never throws into the technician's action — a reporting problem is not a
   * reason to stop someone starting work.
   */
  async openSnapshotOnStart(serviceOrderId: string): Promise<void> {
    const existing = await this.prisma.workOrderKpiSnapshot.findUnique({
      where: { serviceOrderId },
      select: { id: true },
    });
    if (existing) return; // Already opened; the original terms stand.

    const terms = await this.resolveTerms(serviceOrderId);
    if (!terms) return;

    await this.prisma.workOrderKpiSnapshot.create({
      data: {
        serviceOrderId,
        policyId: terms.policy.id,
        policyVersion: terms.policy.version,
        vehicleClass: terms.vehicleClass as never,
        packageType: terms.packageType as never,
        standardMinutes: terms.standardMinutes,
        primaryTechnicianId: terms.primaryTechnicianId,
        // Times and ratings are filled in at submit-to-QC.
        eligibilityStatus: 'ELIGIBLE' as never,
      },
    });

    this.logger.log(
      `KPI snapshot opened for order ${serviceOrderId}: ${terms.packageType}, ` +
        `${terms.vehicleClass ?? 'unclassified'}, standard ${terms.standardMinutes ?? 'n/a'}m`,
    );
  }

  /** Policy, class, package and standard for a job — the terms it is judged on. */
  private async resolveTerms(serviceOrderId: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: {
        items: { select: { serviceTypeId: true, axlePosition: true } },
        assignments: { select: { technicianId: true, isPrimary: true } },
        serviceVisit: { select: { vehicle: { select: { serviceClass: true } } } },
      },
    });
    if (!order) return null;

    const policy = await this.getActivePolicy();
    if (!policy) {
      this.logger.warn(`No active KPI policy — order ${serviceOrderId} cannot be rated.`);
      return null;
    }

    const [componentMap, options] = await Promise.all([
      this.getComponentMap(),
      this.detectionOptions(),
    ]);
    const detection = detectPackage(order.items as never, componentMap, options);

    const vehicleClass = order.serviceVisit?.vehicle?.serviceClass ?? null;
    const usableClass =
      vehicleClass && vehicleClass !== 'UNKNOWN_REQUIRES_REVIEW' ? vehicleClass : null;

    const benchmark =
      usableClass && isBenchmarked(detection.packageType)
        ? policy.benchmarks.find(
            (b) => b.vehicleClass === usableClass && b.packageType === detection.packageType,
          )
        : undefined;

    const primary =
      order.assignments.find((a) => a.isPrimary) ?? order.assignments[0] ?? null;

    return {
      policy,
      detection,
      vehicleClass: usableClass,
      packageType: detection.packageType,
      standardMinutes: benchmark?.standardMinutes ?? null,
      primaryTechnicianId: primary?.technicianId ?? null,
    };
  }

  /**
   * CR-2026-088 — re-evaluate the package after an authorised scope change.
   *
   * Called when services are added or removed. Records the old and new package and
   * standard, and who authorised it. The original snapshot row is updated rather
   * than replaced, and the change is audited, so a job that moved from General
   * Service to General Service + Front Brakes shows why its standard moved too.
   *
   * A combination that is not benchmarked moves the job to CUSTOM_UNBENCHMARKED
   * unless a manager has approved a custom standard.
   */
  async reevaluatePackage(serviceOrderId: string, actorUserId: string): Promise<void> {
    const snapshot = await this.prisma.workOrderKpiSnapshot.findUnique({
      where: { serviceOrderId },
    });
    if (!snapshot) return; // Not started yet — the terms will be set at start.
    if (snapshot.finalisedAt) return; // Finished: never revise after the result is known.

    const terms = await this.resolveTerms(serviceOrderId);
    if (!terms) return;

    const packageChanged = terms.packageType !== snapshot.packageType;
    const standardChanged = terms.standardMinutes !== snapshot.standardMinutes;
    if (!packageChanged && !standardChanged) return;

    await this.prisma.workOrderKpiSnapshot.update({
      where: { serviceOrderId },
      data: {
        packageType: terms.packageType as never,
        // A manager-approved custom standard survives a re-detection.
        standardMinutes: snapshot.customStandardMinutes ?? terms.standardMinutes,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'KPI_PACKAGE_REVISED',
      entityType: 'WorkOrderKpiSnapshot',
      entityId: snapshot.id,
      beforeJson: {
        packageType: snapshot.packageType,
        standardMinutes: snapshot.standardMinutes,
      },
      afterJson: {
        packageType: terms.packageType,
        standardMinutes: snapshot.customStandardMinutes ?? terms.standardMinutes,
      },
      reasonCode: 'SCOPE_CHANGE',
      notes: `Services changed on order ${serviceOrderId}`,
    });

    this.logger.log(
      `KPI package revised for order ${serviceOrderId}: ` +
        `${snapshot.packageType} (${snapshot.standardMinutes ?? 'n/a'}m) -> ` +
        `${terms.packageType} (${terms.standardMinutes ?? 'n/a'}m)`,
    );
  }

  /**
   * A manager-approved standard for a job the benchmark does not cover.
   *
   * Must be set BEFORE the result is known. Once the snapshot is finalised this
   * refuses: changing the benchmark after seeing a poor number is exactly the
   * manipulation the audit trail exists to prevent, and the correction path
   * (`correctFinalisedSnapshot`) is deliberately separate and visibly flagged.
   */
  async approveCustomStandard(input: {
    serviceOrderId: string;
    standardMinutes: number;
    reason: string;
    actorUserId: string;
  }) {
    if (!Number.isInteger(input.standardMinutes) || input.standardMinutes <= 0) {
      throw new BadRequestException('A custom standard must be a positive number of minutes.');
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException('A reason is required to approve a custom standard.');
    }

    const snapshot = await this.prisma.workOrderKpiSnapshot.findUnique({
      where: { serviceOrderId: input.serviceOrderId },
    });
    if (!snapshot) {
      throw new NotFoundException(
        'This job has no KPI record yet — a custom standard can be set once work has started.',
      );
    }
    if (snapshot.finalisedAt) {
      throw new BadRequestException(
        'This job is already finished. A benchmark cannot be set after the result is known.',
      );
    }

    const updated = await this.prisma.workOrderKpiSnapshot.update({
      where: { serviceOrderId: input.serviceOrderId },
      data: {
        customStandardMinutes: input.standardMinutes,
        customStandardReason: input.reason.trim(),
        customStandardByUserId: input.actorUserId,
        customStandardApprovedAt: new Date(),
        standardMinutes: input.standardMinutes,
      },
    });

    await this.audit.log({
      actorUserId: input.actorUserId,
      action: 'KPI_CUSTOM_STANDARD_APPROVED',
      entityType: 'WorkOrderKpiSnapshot',
      entityId: snapshot.id,
      beforeJson: { standardMinutes: snapshot.standardMinutes, packageType: snapshot.packageType },
      afterJson: { standardMinutes: input.standardMinutes },
      reasonCode: 'CUSTOM_STANDARD',
      notes: input.reason,
    });

    return updated;
  }

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

    if (existing?.finalisedAt) {
      // Second trip through QC. Preserve the original completion result and record
      // that quality failed — speed must never be improvable by reworking, and a
      // failed job should read as a quality problem, not a slow one.
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
        startedAt: true,
        completedAt: true,
        assignments: { select: { technicianId: true, isPrimary: true } },
      },
    });
    if (!order) return;

    // Terms come from the snapshot opened at START where one exists, so a manager's
    // approved custom standard or a mid-job package revision is honoured rather than
    // silently re-detected at the finish line.
    const terms = existing ? null : await this.resolveTerms(serviceOrderId);
    const policy = existing
      ? await this.prisma.kpiPolicy.findUnique({ where: { id: existing.policyId } })
      : terms?.policy ?? null;
    if (!policy) {
      this.logger.warn(
        `No KPI policy for order ${serviceOrderId} — cannot finalise. Run the seed.`,
      );
      return;
    }

    const vehicleClass = existing ? existing.vehicleClass : (terms?.vehicleClass ?? null);
    const packageType = existing ? existing.packageType : (terms?.packageType ?? 'CUSTOM_UNBENCHMARKED');
    const standardMinutes = existing ? existing.standardMinutes : (terms?.standardMinutes ?? null);

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
      vehicleClass,
      packageType: packageType as KpiPackageType,
      standardMinutes,
      hasPrimaryTechnician: !!primary,
      firstWorkStartedAt: order.startedAt,
      firstSubmittedToQcAt: order.completedAt,
      computedMinutes: result.kpiCompletionMinutes,
      detectionReason: terms?.detection.reason ?? null,
    });

    const data = {
      policyId: policy.id,
      policyVersion: policy.version,
      vehicleClass: vehicleClass as never,
      packageType: packageType as never,
      standardMinutes,
      firstWorkStartedAt: order.startedAt,
      firstSubmittedToQcAt: order.completedAt,
      rawElapsedMinutes: result.rawElapsedMinutes,
      approvedExcludedMinutes: result.approvedExcludedMinutes,
      kpiCompletionMinutes: result.kpiCompletionMinutes,
      varianceMinutes: result.varianceMinutes,
      variancePercent: result.variancePercent,
      absoluteCompletionRating: result.absoluteCompletionRating as never,
      // A job that is not formally eligible gets NO adjusted rating, even where the
      // arithmetic produced one — a misleading rating is worse than none.
      adjustedTechnicianRating:
        eligibilityStatus === 'ELIGIBLE' ? (result.adjustedTechnicianRating as never) : null,
      onTarget: eligibilityStatus === 'ELIGIBLE' ? result.onTarget : false,
      eligibilityStatus: eligibilityStatus as never,
      eligibilityReason,
      primaryTechnicianId: primary?.technicianId ?? null,
      isSharedOrReassigned,
      finalisedAt: new Date(),
    };

    if (existing) {
      await this.prisma.workOrderKpiSnapshot.update({ where: { serviceOrderId }, data });
    } else {
      await this.prisma.workOrderKpiSnapshot.create({ data: { serviceOrderId, ...data } });
    }

    this.logger.log(
      `KPI finalised for order ${serviceOrderId}: ${packageType}, ` +
        `standard ${standardMinutes ?? 'n/a'}m, ` +
        `actual ${result.kpiCompletionMinutes ?? 'n/a'}m, ${eligibilityStatus}`,
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
        items: { select: { serviceTypeId: true, axlePosition: true } },
        serviceVisit: { select: { vehicle: { select: { serviceClass: true } } } },
      },
    });
    if (!order) throw new NotFoundException(`Service order ${serviceOrderId} not found`);

    const [policy, componentMap, detectOptions, delays] = await Promise.all([
      this.getActivePolicy(now),
      this.getComponentMap(),
      this.detectionOptions(),
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

    const detection = detectPackage(order.items as never, componentMap, detectOptions);
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
