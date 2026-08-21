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
  isBenchmarked,
  type KpiPackageType,
  type PackageComponentMap,
} from './engine/package-detection';
import {
  calculateStandard,
  type ContributionPolicyMap,
  type StandardCalculation,
  type WorkOrderLine,
  type VehicleClass,
} from './engine/contribution-resolution';

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
   * CR-2026-092 — the contribution policy for every service, as at a moment.
   *
   * Same effective-dating rule as the mapping above, and for the same reason: a
   * completed job must stay explicable under the policy that produced it.
   */
  async getContributionPolicies(at: Date = new Date()): Promise<ContributionPolicyMap> {
    const rows = await this.prisma.kpiServiceComponent.findMany({
      where: {
        isActive: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      select: {
        serviceTypeId: true,
        contributionMode: true,
        componentRole: true,
        durationSource: true,
        fixedSedanMinutes: true,
        fixedSuvMinutes: true,
        allowanceBasis: true,
        requiredQualifier: true,
        provisionalDuration: true,
      },
    });

    return new Map(
      rows.map((r) => [
        r.serviceTypeId,
        {
          contributionMode: r.contributionMode as never,
          componentRole: r.componentRole as never,
          durationSource: r.durationSource as never,
          fixedSedanMinutes: r.fixedSedanMinutes,
          fixedSuvMinutes: r.fixedSuvMinutes,
          allowanceBasis: r.allowanceBasis as never,
          requiredQualifier: r.requiredQualifier as never,
          provisionalDuration: r.provisionalDuration,
        },
      ]),
    );
  }

  /**
   * Everything the calculation needs about a job: its lines with their qualifiers and
   * catalogue durations, plus the vehicle class that picks the package base.
   */
  private async loadJobForCalculation(serviceOrderId: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: {
        items: {
          select: {
            id: true,
            serviceTypeId: true,
            status: true,
            axlePosition: true,
            brakeWorkType: true,
            tireOperation: true,
            unitQuantity: true,
            serviceType: {
              select: { code: true, name: true, baseDurationMinutes: true },
            },
          },
        },
        serviceVisit: { select: { vehicle: { select: { serviceClass: true } } } },
      },
    });
    if (!order) return null;

    const lines: WorkOrderLine[] = order.items.map((i) => ({
      id: i.id,
      serviceTypeId: i.serviceTypeId,
      serviceCode: i.serviceType.code,
      serviceName: i.serviceType.name,
      catalogueMinutes: i.serviceType.baseDurationMinutes,
      status: i.status,
      axlePosition: i.axlePosition as never,
      brakeWorkType: i.brakeWorkType as never,
      tireOperation: i.tireOperation as never,
      unitQuantity: i.unitQuantity,
    }));

    const raw = order.serviceVisit?.vehicle?.serviceClass ?? null;
    const vehicleClass =
      raw && raw !== 'UNKNOWN_REQUIRES_REVIEW' ? (raw as VehicleClass) : null;

    return { lines, vehicleClass };
  }

  /**
   * Work out a job's final standard and the arithmetic behind it.
   *
   * The package base comes from the effective policy rather than a constant, so a
   * retuned matrix applies to new jobs without touching finished ones.
   */
  async calculateStandardForOrder(serviceOrderId: string, at: Date = new Date()) {
    const [job, policies, kpiPolicy] = await Promise.all([
      this.loadJobForCalculation(serviceOrderId),
      this.getContributionPolicies(at),
      this.getActivePolicy(at),
    ]);
    if (!job) throw new NotFoundException(`Service order ${serviceOrderId} not found`);

    return calculateStandard(job.lines, policies, {
      vehicleClass: job.vehicleClass,
      packageStandard: (cls, pkg) =>
        kpiPolicy?.benchmarks.find(
          (b) => b.vehicleClass === cls && b.packageType === pkg,
        )?.standardMinutes ?? null,
    });
  }

  /**
   * The display-shaped calculation breakdown for a job, with its vehicle class.
   *
   * One shape, produced in one place. The live endpoint and the readiness endpoint both
   * serve it, so a screen showing the strip and the calculation panel together never
   * has to reconcile two renderings of the same arithmetic.
   */
  async getCalculationBreakdown(serviceOrderId: string, at: Date = new Date()) {
    const [job, calc] = await Promise.all([
      this.loadJobForCalculation(serviceOrderId),
      this.calculateStandardForOrder(serviceOrderId, at),
    ]);
    return {
      vehicleClass: job?.vehicleClass ?? null,
      breakdown: this.breakdownJson(calc),
    };
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

  /**
   * Classify a work order's services and show the standard it produces.
   *
   * Kept on the same route the UI already calls, because the answer it wants has not
   * changed — only how much of the working is now visible.
   */
  async detectPackageForOrder(serviceOrderId: string) {
    const calc = await this.calculateStandardForOrder(serviceOrderId);
    return {
      ...calc,
      // The old field names the technician strip and axle prompt already read.
      unmappedServiceTypeIds: calc.unmappedServiceTypeIds,
      awaitingAxleQualifierServiceTypeIds: calc.missingQualifiers.map((m) => m.lineId),
      resolvableByAxleQualifier:
        calc.missingQualifiers.length > 0 && calc.unmappedServiceTypeIds.length === 0,
    };
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
        // CR-2026-091 — recorded now, while the mapping that produced it is the one in
        // force. Deciding this at the finish line would classify the job against a
        // mapping that may have changed while the work was under way.
        pendingBenchmarkReview: terms.calculation.requiresBenchmarkReview,
        // CR-2026-092 — how the standard was built, and the arithmetic behind it.
        benchmarkSource: terms.benchmarkSource as never,
        calculationBreakdown: this.breakdownJson(terms.calculation) as never,
      },
    });

    this.logger.log(
      `KPI snapshot opened for order ${serviceOrderId}: ${terms.packageType}, ` +
        `${terms.vehicleClass ?? 'unclassified'}, standard ${terms.standardMinutes ?? 'n/a'}m ` +
        `(${terms.benchmarkSource})`,
    );
  }

  /**
   * Policy, class, package and standard for a job — the terms it is judged on.
   *
   * CR-2026-092 — the standard is now the CALCULATED one: package base plus approved
   * additives, or a sum of catalogue standards where there is no General Service. The
   * arithmetic comes back with it, because a standard nobody can reconstruct is a
   * standard nobody can defend in a review with the technician it rated.
   */
  private async resolveTerms(serviceOrderId: string) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: { assignments: { select: { technicianId: true, isPrimary: true } } },
    });
    if (!order) return null;

    const policy = await this.getActivePolicy();
    if (!policy) {
      this.logger.warn(`No active KPI policy — order ${serviceOrderId} cannot be rated.`);
      return null;
    }

    const [job, policies] = await Promise.all([
      this.loadJobForCalculation(serviceOrderId),
      this.getContributionPolicies(),
    ]);
    if (!job) return null;

    const calculation = calculateStandard(job.lines, policies, {
      vehicleClass: job.vehicleClass,
      packageStandard: (cls, pkg) =>
        policy.benchmarks.find((b) => b.vehicleClass === cls && b.packageType === pkg)
          ?.standardMinutes ?? null,
    });

    const primary =
      order.assignments.find((a) => a.isPrimary) ?? order.assignments[0] ?? null;

    return {
      policy,
      calculation,
      // `detection` is kept as an alias so the eligibility and review paths written
      // against CR-2026-091 keep reading the same field names.
      detection: calculation,
      vehicleClass: job.vehicleClass,
      packageType: calculation.packageType,
      standardMinutes: calculation.finalStandardMinutes,
      benchmarkSource: calculation.benchmarkSource,
      primaryTechnicianId: primary?.technicianId ?? null,
    };
  }

  /**
   * The stored form of a calculation: enough to reprint the breakdown months later
   * without re-running anything.
   */
  private breakdownJson(calc: StandardCalculation) {
    return {
      packageType: calc.packageType,
      benchmarkSource: calc.benchmarkSource,
      components: calc.components,
      basePackageMinutes: calc.basePackageMinutes,
      additiveMinutes: calc.additiveMinutes,
      finalStandardMinutes: calc.finalStandardMinutes,
      provisionalDurationsUsed: calc.provisionalDurationsUsed,
      lines: calc.contributions.map((c) => ({
        serviceCode: c.serviceCode,
        serviceName: c.serviceName,
        mode: c.mode,
        minutes: c.minutes,
        qualifierLabel: c.qualifierLabel,
        provisional: c.provisional,
        suppressedAsDuplicate: c.suppressedAsDuplicate ?? false,
        note: c.note,
      })),
      missingQualifiers: calc.missingQualifiers.map((m) => ({
        serviceCode: m.serviceCode,
        message: m.message,
      })),
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
    // CR-2026-091 — recording an axle or mapping a service closes the gap without
    // necessarily moving the package, so this has to be checked in its own right or a
    // job would stay flagged for review after the thing it was waiting for arrived.
    const reviewChanged =
      terms.calculation.requiresBenchmarkReview !== snapshot.pendingBenchmarkReview;
    const sourceChanged = terms.benchmarkSource !== snapshot.benchmarkSource;
    if (!packageChanged && !standardChanged && !reviewChanged && !sourceChanged) return;

    const newStandard = snapshot.customStandardMinutes ?? terms.standardMinutes;

    // CR-2026-092 — the superseded arithmetic is kept, not overwritten. A technician
    // told mid-job that their benchmark moved is entitled to see what it moved from,
    // and a manager reviewing the job later needs the same. Elapsed time is untouched:
    // the scope changed, the clock did not restart.
    const revisions = Array.isArray(snapshot.calculationRevisions)
      ? (snapshot.calculationRevisions as unknown[])
      : [];
    revisions.push({
      supersededAt: new Date().toISOString(),
      byUserId: actorUserId,
      reason: 'SCOPE_CHANGE',
      packageType: snapshot.packageType,
      standardMinutes: snapshot.standardMinutes,
      benchmarkSource: snapshot.benchmarkSource,
      breakdown: snapshot.calculationBreakdown ?? null,
    });

    await this.prisma.workOrderKpiSnapshot.update({
      where: { serviceOrderId },
      data: {
        packageType: terms.packageType as never,
        // A manager-approved custom standard survives a re-detection.
        standardMinutes: newStandard,
        pendingBenchmarkReview: terms.calculation.requiresBenchmarkReview,
        benchmarkSource: (snapshot.customStandardMinutes != null
          ? 'MANAGER_CUSTOM'
          : terms.benchmarkSource) as never,
        calculationBreakdown: this.breakdownJson(terms.calculation) as never,
        calculationRevisions: revisions as never,
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
        benchmarkSource: snapshot.benchmarkSource,
      },
      afterJson: {
        packageType: terms.packageType,
        standardMinutes: newStandard,
        benchmarkSource: terms.benchmarkSource,
      },
      reasonCode: 'SCOPE_CHANGE',
      notes: `Services changed on order ${serviceOrderId}`,
    });

    this.logger.log(
      `KPI standard revised for order ${serviceOrderId}: ` +
        `${snapshot.standardMinutes ?? 'n/a'}m -> ${newStandard ?? 'n/a'}m ` +
        `(${terms.benchmarkSource}, revision ${revisions.length})`,
    );
  }

  /**
   * CR-2026-091 — rate a finished job that was held for benchmark review.
   *
   * Why this is allowed when revising a finalised snapshot generally is not: those two
   * things look alike but are opposites. The immutability rule exists so a KNOWN result
   * cannot be rewritten after the fact. A job pending benchmark review has no result to
   * protect — it was never rated, because nobody had said what to measure it against.
   * This produces its first rating rather than replacing one.
   *
   * Without it, "leave the service unmapped for now" would quietly mean "this job is
   * never rated", and a temporary administrative gap would become permanent data loss.
   *
   * The safeguards that keep this from becoming a way to tune results:
   *  - It refuses any job that already carries a rating.
   *  - It re-detects rather than accepting a supplied answer, so the rating comes from
   *    the mapping the manager configured for ALL jobs, not one chosen for this one.
   *  - The times are the stored ones. Only the standard was ever missing.
   *  - Who resolved it and when are recorded on the snapshot and audited.
   */
  async resolveBenchmarkReview(serviceOrderId: string, actorUserId: string) {
    const snapshot = await this.prisma.workOrderKpiSnapshot.findUnique({
      where: { serviceOrderId },
    });
    if (!snapshot) {
      throw new NotFoundException(`No KPI snapshot for order ${serviceOrderId}`);
    }
    if (!snapshot.pendingBenchmarkReview) {
      throw new BadRequestException(
        'This job is not awaiting benchmark review. A job that already carries a rating is never re-rated.',
      );
    }

    const terms = await this.resolveTerms(serviceOrderId);
    if (!terms) {
      throw new BadRequestException('The job’s terms could not be resolved.');
    }

    if (terms.calculation.requiresBenchmarkReview) {
      throw new BadRequestException(
        `Still awaiting configuration: ${terms.calculation.reason ?? 'a service on this job is not mapped.'}`,
      );
    }

    const policy = await this.prisma.kpiPolicy.findUnique({
      where: { id: snapshot.policyId },
    });
    if (!policy) throw new BadRequestException('The policy this job was opened under is missing.');

    const standardMinutes = snapshot.customStandardMinutes ?? terms.standardMinutes;

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
      firstWorkStartedAt: snapshot.firstWorkStartedAt,
      firstSubmittedToQcAt: snapshot.firstSubmittedToQcAt,
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

    const { eligibilityStatus, eligibilityReason } = this.evaluateEligibility({
      vehicleClass: snapshot.vehicleClass,
      packageType: terms.packageType as KpiPackageType,
      standardMinutes,
      hasPrimaryTechnician: !!snapshot.primaryTechnicianId,
      firstWorkStartedAt: snapshot.firstWorkStartedAt,
      firstSubmittedToQcAt: snapshot.firstSubmittedToQcAt,
      computedMinutes: result.kpiCompletionMinutes,
      detectionReason: terms.calculation.reason,
      requiresBenchmarkReview: false,
    });

    const updated = await this.prisma.workOrderKpiSnapshot.update({
      where: { serviceOrderId },
      data: {
        packageType: terms.packageType as never,
        standardMinutes,
        varianceMinutes: result.varianceMinutes,
        variancePercent: result.variancePercent,
        absoluteCompletionRating: result.absoluteCompletionRating as never,
        adjustedTechnicianRating:
          eligibilityStatus === 'ELIGIBLE' ? (result.adjustedTechnicianRating as never) : null,
        onTarget: eligibilityStatus === 'ELIGIBLE' ? result.onTarget : false,
        eligibilityStatus: eligibilityStatus as never,
        eligibilityReason,
        pendingBenchmarkReview: false,
        benchmarkResolvedAt: new Date(),
        benchmarkResolvedByUserId: actorUserId,
        benchmarkSource: terms.benchmarkSource as never,
        calculationBreakdown: this.breakdownJson(terms.calculation) as never,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'KPI_BENCHMARK_REVIEW_RESOLVED',
      entityType: 'WorkOrderKpiSnapshot',
      entityId: snapshot.id,
      beforeJson: {
        eligibilityStatus: snapshot.eligibilityStatus,
        packageType: snapshot.packageType,
        standardMinutes: snapshot.standardMinutes,
      },
      afterJson: {
        eligibilityStatus,
        packageType: terms.packageType,
        standardMinutes,
        adjustedTechnicianRating: updated.adjustedTechnicianRating,
      },
      reasonCode: 'BENCHMARK_REVIEW',
      notes: `Benchmark configuration supplied; order ${serviceOrderId} rated for the first time.`,
    });

    this.logger.log(
      `Benchmark review resolved for order ${serviceOrderId}: ${terms.packageType}, ` +
        `standard ${standardMinutes ?? 'n/a'}m, ${eligibilityStatus}`,
    );
    return updated;
  }

  /**
   * Jobs held for benchmark review — the queue that stops a temporary gap becoming a
   * permanent one.
   *
   * These carry no rating and sit outside every technician denominator, so nothing
   * about them is wrong; but nothing surfaces them either unless something lists them.
   */
  async listPendingBenchmarkReview(limit = 200) {
    const rows = await this.prisma.workOrderKpiSnapshot.findMany({
      where: { pendingBenchmarkReview: true },
      orderBy: { firstSubmittedToQcAt: 'desc' },
      take: Math.min(limit, 1000),
      include: {
        serviceOrder: {
          select: {
            items: {
              select: {
                axlePosition: true,
                serviceType: { select: { id: true, code: true, name: true } },
              },
            },
            serviceVisit: {
              select: {
                queueTicket: { select: { ticketNumber: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
    });

    const componentMap = await this.getComponentMap();

    return rows.map((r) => ({
      serviceOrderId: r.serviceOrderId,
      ticketNumber: r.serviceOrder?.serviceVisit?.queueTicket?.ticketNumber ?? null,
      plate: r.serviceOrder?.serviceVisit?.vehicle?.plateNumber ?? null,
      vehicleClass: r.vehicleClass,
      firstSubmittedToQcAt: r.firstSubmittedToQcAt,
      rawElapsedMinutes: r.rawElapsedMinutes,
      eligibilityReason: r.eligibilityReason,
      // Exactly what is missing, so the queue is actionable rather than a list of
      // complaints. A service with no active mapping is the usual culprit.
      blockingServices: (r.serviceOrder?.items ?? [])
        .filter((i) => {
          const m = componentMap.get(i.serviceType.id);
          if (!m) return true;
          return m.requiresAxleQualifier && i.axlePosition == null;
        })
        .map((i) => ({
          code: i.serviceType.code,
          name: i.serviceType.name,
          problem: componentMap.get(i.serviceType.id)
            ? 'Axle not recorded'
            : 'Not mapped to a benchmark component',
        })),
    }));
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
        // A manager-set standard is its own provenance — it did not come from the
        // package matrix or the catalogue.
        benchmarkSource: 'MANAGER_CUSTOM' as never,
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
      // Read from the snapshot where one was opened at start, so the classification
      // reflects the mapping in force when the job ran rather than whatever the
      // mapping says now.
      requiresBenchmarkReview: existing
        ? existing.pendingBenchmarkReview
        : (terms?.detection.requiresBenchmarkReview ?? false),
    });

    const pendingReview = eligibilityStatus === 'PENDING_BENCHMARK_REVIEW';

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
      // CR-2026-091 — a job awaiting benchmark configuration carries NO rating of any
      // kind, not even the absolute band.
      //
      // The absolute band needs no benchmark, which is why CR-2026-088 applied it
      // wherever a time existed. But a job is in this state precisely because it
      // included work nobody has accounted for, and that unaccounted work is the most
      // likely reason it ran long. Showing "Below Standard" against it charges the
      // technician for an administrative gap — an implicitly negative result from a
      // missing mapping. Left null until the gap is closed.
      absoluteCompletionRating: pendingReview
        ? null
        : (result.absoluteCompletionRating as never),
      // A job that is not formally eligible gets NO adjusted rating, even where the
      // arithmetic produced one — a misleading rating is worse than none.
      adjustedTechnicianRating:
        eligibilityStatus === 'ELIGIBLE' ? (result.adjustedTechnicianRating as never) : null,
      onTarget: eligibilityStatus === 'ELIGIBLE' ? result.onTarget : false,
      eligibilityStatus: eligibilityStatus as never,
      eligibilityReason,
      pendingBenchmarkReview: pendingReview,
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
    requiresBenchmarkReview: boolean;
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
      // CR-2026-091 — two very different situations reach this line, and conflating
      // them is what let an admin gap read as a technician's poor result.
      //
      // A configuration gap is an outstanding task: someone has not mapped a service,
      // or an axle was never recorded. The technician did the work; nobody has yet
      // said what it should be measured against. That job carries NO rating at all
      // until the gap is closed — see the absolute-rating suppression at the call site.
      if (input.requiresBenchmarkReview) {
        return {
          eligibilityStatus: 'PENDING_BENCHMARK_REVIEW',
          eligibilityReason:
            input.detectionReason ??
            'A service on this job is not mapped to a benchmark component yet.',
        };
      }
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
      select: { startedAt: true, completedAt: true },
    });
    if (!order) throw new NotFoundException(`Service order ${serviceOrderId} not found`);

    // A live job reads its standard from the OPEN SNAPSHOT where one exists, so the
    // strip counts down against the terms the job was started under rather than
    // against whatever the mapping says this second. Only an unstarted job is
    // calculated fresh.
    const [policy, snapshot, delays] = await Promise.all([
      this.getActivePolicy(now),
      this.prisma.workOrderKpiSnapshot.findUnique({ where: { serviceOrderId } }),
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

    const detection =
      snapshot && snapshot.calculationBreakdown
        ? null
        : await this.calculateStandardForOrder(serviceOrderId, now);

    const usableClass = (snapshot?.vehicleClass ??
      (await this.loadJobForCalculation(serviceOrderId))?.vehicleClass ??
      null) as VehicleClass | null;

    const standardMinutes =
      snapshot?.customStandardMinutes ??
      snapshot?.standardMinutes ??
      detection?.finalStandardMinutes ??
      null;

    const breakdown =
      (snapshot?.calculationBreakdown as never) ??
      (detection ? this.breakdownJson(detection) : null);

    const result = calculateKpi({
      firstWorkStartedAt: order.startedAt,
      firstSubmittedToQcAt: order.completedAt,
      delays: delays as DelaySpan[],
      standardMinutes,
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
      packageType: (snapshot?.packageType ?? detection?.packageType ?? 'CUSTOM_UNBENCHMARKED') as string,
      packageReason: detection?.reason ?? null,
      standardMinutes,
      // CR-2026-092 — what the standard was built from, so a strip showing "120 min"
      // says whether that is a package or a sum of catalogue times.
      benchmarkSource:
        snapshot?.benchmarkSource ?? detection?.benchmarkSource ?? 'NOT_TECHNICIAN_RATED',
      calculationBreakdown: breakdown,
      pendingBenchmarkReview:
        snapshot?.pendingBenchmarkReview ?? detection?.requiresBenchmarkReview ?? false,
      missingQualifiers: detection?.missingQualifiers ?? [],
      minutesRemaining:
        standardMinutes != null && result.kpiCompletionMinutes != null
          ? standardMinutes - result.kpiCompletionMinutes
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
