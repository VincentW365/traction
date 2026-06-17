import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  Prisma,
  VehicleServiceClass,
  VehicleWeightClass,
  ClassificationStatus,
  ClassificationConfidence,
  ClassificationSource,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import {
  liveVehicleWhere,
  isPlaceholderVehicle,
} from '../../common/helpers/operational-scope';
import {
  suggestVehicleClass,
  type VehicleSuggestionRule,
} from '../../common/helpers/vehicle-classification';

export interface ConfirmClassificationInput {
  serviceClass: VehicleServiceClass;
  weightClass?: VehicleWeightClass;
  notes?: string;
}

export interface ClassificationQueueOptions {
  limit?: number;
  offset?: number;
  confidence?: ClassificationConfidence;
  search?: string;
}

/**
 * CR-2026-008 — Vehicle ServiceClass classification workflow.
 *
 * Suggestion-assisted, STAFF-CONFIRMED. The operational Vehicle.serviceClass is
 * written ONLY via confirm/bulkConfirm here (or the check-in path); make/model
 * suggestions are advisory and never auto-applied. Until confirmed, the vehicle
 * stays mobile-jack blocked (DMAIC Rule 3, resource-compatibility.checker, is
 * untouched). Every confirmation writes an AuditLog + StatusHistory + the
 * VehicleClassification audit record.
 */
@Injectable()
export class ClassificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statusHistory: StatusHistoryService,
  ) {}

  private async loadRules(): Promise<VehicleSuggestionRule[]> {
    const rows = await this.prisma.vehicleWeightSuggestion.findMany();
    return rows.map((r) => ({
      makePattern: r.makePattern,
      modelPattern: r.modelPattern,
      yearFrom: r.yearFrom,
      yearTo: r.yearTo,
      suggestedWeightClass: r.suggestedWeightClass,
      suggestedServiceClass: r.suggestedServiceClass,
    }));
  }

  /**
   * Review queue: LIVE vehicles still needing an operational serviceClass.
   * Excludes historical/placeholder vehicles (CR-2026-006). Engine number and
   * other sensitive fields are never selected/returned here.
   *
   * Read-only filtering/search/ordering/paging (CR-2026-009) to make the
   * imported backlog workable. "Suggestable first" ordering surfaces the rows
   * that have an advisory class (HIGH→NONE) before the unmatched ones.
   */
  async getQueue(opts: ClassificationQueueOptions = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where: Prisma.VehicleWhereInput = {
      serviceClass: null,
      ...liveVehicleWhere(false),
      ...(opts.confidence
        ? { classification: { is: { confidence: opts.confidence } } }
        : {}),
      ...(opts.search && opts.search.trim()
        ? {
            OR: [
              { make: { contains: opts.search.trim(), mode: 'insensitive' } },
              { model: { contains: opts.search.trim(), mode: 'insensitive' } },
              { plateNumber: { contains: opts.search.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, vehicles] = await Promise.all([
      this.prisma.vehicle.count({ where }),
      this.prisma.vehicle.findMany({
        where,
        select: {
          id: true,
          vehicleCode: true,
          plateNumber: true,
          make: true,
          model: true,
          modelYear: true,
          weightClass: true,
          serviceClass: true,
          classification: true,
          customer: { select: { firstName: true, lastName: true } },
        },
        // enum declared HIGH, MEDIUM, LOW, NONE → asc = suggestable first; null relation last.
        orderBy: [{ classification: { confidence: 'asc' } }, { updatedAt: 'desc' }],
        skip: offset,
        take: limit,
      }),
    ]);

    const rules = await this.loadRules();

    const items = vehicles.map((v) => {
      // Prefer a stored suggestion; otherwise compute advisory on the fly.
      const stored = v.classification;
      const suggestion =
        stored && stored.confidence
          ? {
              suggestedServiceClass: stored.suggestedServiceClass,
              suggestedWeightClass: stored.suggestedWeightClass,
              confidence: stored.confidence,
              source: stored.source,
            }
          : suggestVehicleClass(
              { make: v.make, model: v.model, modelYear: v.modelYear },
              rules,
            );

      return {
        vehicleId: v.id,
        vehicleCode: v.vehicleCode,
        plateNumber: v.plateNumber,
        make: v.make,
        model: v.model,
        modelYear: v.modelYear,
        currentServiceClass: v.serviceClass, // null while in the queue
        currentWeightClass: v.weightClass,
        customerName: `${v.customer.firstName} ${v.customer.lastName}`.trim(),
        classificationStatus: stored?.status ?? ClassificationStatus.PENDING_REVIEW,
        suggestion,
      };
    });

    return { items, total, limit, offset };
  }

  /**
   * Read-only progress snapshot (CR-2026-010) — counts only, no PII.
   * Live-only (excludes historical placeholders via liveVehicleWhere). Used by
   * the manager Reports view to track classification burn-down. Does not read or
   * return any plate/VIN/engine fields.
   */
  async getStats() {
    const liveWhere = liveVehicleWhere(false);
    const serviceClasses = Object.values(VehicleServiceClass);
    const confidences = Object.values(ClassificationConfidence);

    const [totalLive, unclassified, byClassCounts, byConfidenceCounts] = await Promise.all([
      this.prisma.vehicle.count({ where: liveWhere }),
      this.prisma.vehicle.count({ where: { serviceClass: null, ...liveWhere } }),
      Promise.all(
        serviceClasses.map((sc) =>
          this.prisma.vehicle.count({ where: { serviceClass: sc, ...liveWhere } }),
        ),
      ),
      Promise.all(
        confidences.map((cf) =>
          this.prisma.vehicle.count({
            where: { serviceClass: null, ...liveWhere, classification: { is: { confidence: cf } } },
          }),
        ),
      ),
    ]);

    const classified = totalLive - unclassified;
    const confirmedByClass = serviceClasses.map((serviceClass, i) => ({
      serviceClass,
      count: byClassCounts[i],
    }));
    const pendingByConfidence = confidences.map((confidence, i) => ({
      confidence,
      count: byConfidenceCounts[i],
    }));
    const mobileJackEligible =
      confirmedByClass.find((c) => c.serviceClass === VehicleServiceClass.SEDAN_CLASS)?.count ?? 0;
    const percentClassified = totalLive > 0 ? Math.round((classified / totalLive) * 100) : 0;

    return {
      totalLive,
      classified,
      unclassified,
      percentClassified,
      mobileJackEligible,
      confirmedByClass,
      pendingByConfidence,
    };
  }

  /**
   * Read-only productivity snapshot (CR-2026-012) — counts only, no writes.
   * Tracks classification throughput for managers: daily target vs today's
   * confirmations, confirmation velocity over a window, and a per-reviewer
   * breakdown. Daily target comes from BusinessRuleConfig (default 50).
   */
  async getProductivity(opts: { days?: number } = {}) {
    const days = Math.min(Math.max(opts.days ?? 14, 1), 90);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const from = new Date(todayStart);
    from.setDate(from.getDate() - (days - 1)); // window includes today + (days-1) prior

    // Daily target from BusinessRuleConfig (editable); default 50 when absent.
    const targetRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'classification_daily_target' },
      orderBy: { effectiveFrom: 'desc' },
    });
    const dailyTarget = this.readDailyTarget(targetRule?.valueJson) ?? 50;

    const [todayConfirmed, remainingUnclassified, velocityRows, reviewerRows] = await Promise.all([
      this.prisma.vehicleClassification.count({
        where: { status: 'CONFIRMED', reviewedAt: { gte: todayStart } },
      }),
      this.prisma.vehicle.count({ where: { serviceClass: null, ...liveVehicleWhere(false) } }),
      this.prisma.$queryRaw<Array<{ day: Date; confirmed: number }>>`
        SELECT date_trunc('day', reviewed_at) AS day, COUNT(*)::int AS confirmed
        FROM vehicle_classifications
        WHERE status = 'CONFIRMED' AND reviewed_at >= ${from}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<Array<{ reviewerId: string; reviewerName: string; confirmed: number }>>`
        SELECT vc.reviewed_by_user_id AS "reviewerId", ua.full_name AS "reviewerName", COUNT(*)::int AS confirmed
        FROM vehicle_classifications vc
        JOIN user_accounts ua ON ua.id = vc.reviewed_by_user_id
        WHERE vc.status = 'CONFIRMED' AND vc.reviewed_at >= ${from}
        GROUP BY 1, 2 ORDER BY confirmed DESC`,
    ]);

    const velocity = velocityRows.map((r) => ({
      date: new Date(r.day).toISOString().slice(0, 10),
      confirmed: Number(r.confirmed),
    }));
    const byReviewer = reviewerRows.map((r) => ({
      reviewerId: r.reviewerId,
      reviewerName: r.reviewerName,
      confirmed: Number(r.confirmed),
    }));

    const windowTotal = velocity.reduce((s, v) => s + v.confirmed, 0);
    const activeDays = velocity.length || 1; // days that had at least one confirmation
    const recentAvgPerDay = Math.round((windowTotal / activeDays) * 10) / 10;
    const projectionDaysAtRecent =
      recentAvgPerDay > 0 ? Math.ceil(remainingUnclassified / recentAvgPerDay) : null;
    const projectionDaysAtTarget =
      dailyTarget > 0 ? Math.ceil(remainingUnclassified / dailyTarget) : null;

    return {
      days,
      dailyTarget,
      today: {
        confirmed: todayConfirmed,
        target: dailyTarget,
        remainingToTarget: Math.max(dailyTarget - todayConfirmed, 0),
      },
      remainingUnclassified,
      recentAvgPerDay,
      projectionDaysAtRecent,
      projectionDaysAtTarget,
      velocity,
      byReviewer,
    };
  }

  /** Parse a BusinessRuleConfig value into a positive daily-target number, or null. */
  private readDailyTarget(value: unknown): number | null {
    if (typeof value === 'number' && value > 0) return value;
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const n = v.target ?? v.value;
      if (typeof n === 'number' && n > 0) return n;
    }
    return null;
  }

  /**
   * Staff confirm/adjust a single vehicle's serviceClass (+ optional weightClass).
   * Writes the operational field, the audit record, an AuditLog and StatusHistory.
   */
  async confirm(
    vehicleId: string,
    userId: string,
    input: ConfirmClassificationInput,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        id: true,
        vehicleCode: true,
        make: true,
        model: true,
        modelYear: true,
        serviceClass: true,
        weightClass: true,
      },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle with id ${vehicleId} not found`);
    }
    if (isPlaceholderVehicle(vehicle)) {
      throw new BadRequestException(
        'Cannot classify a historical placeholder vehicle',
      );
    }

    const before = {
      serviceClass: vehicle.serviceClass,
      weightClass: vehicle.weightClass,
    };
    const after = {
      serviceClass: input.serviceClass,
      weightClass: input.weightClass ?? vehicle.weightClass,
    };

    const rules = await this.loadRules();
    const suggestion = suggestVehicleClass(
      { make: vehicle.make, model: vehicle.model, modelYear: vehicle.modelYear },
      rules,
    );
    const reviewedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          serviceClass: input.serviceClass,
          ...(input.weightClass !== undefined && { weightClass: input.weightClass }),
        },
      });

      await tx.vehicleClassification.upsert({
        where: { vehicleId },
        create: {
          vehicleId,
          status: ClassificationStatus.CONFIRMED,
          suggestedServiceClass: suggestion.suggestedServiceClass,
          suggestedWeightClass: suggestion.suggestedWeightClass,
          confidence: suggestion.confidence,
          source: ClassificationSource.MANUAL,
          confirmedServiceClass: input.serviceClass,
          confirmedWeightClass: after.weightClass,
          reviewedByUserId: userId,
          reviewedAt,
        },
        update: {
          status: ClassificationStatus.CONFIRMED,
          source: ClassificationSource.MANUAL,
          confirmedServiceClass: input.serviceClass,
          confirmedWeightClass: after.weightClass,
          reviewedByUserId: userId,
          reviewedAt,
        },
      });
    });

    await this.writeAuditTrail(vehicleId, userId, before, after, input.notes);

    return { vehicleId, confirmed: after };
  }

  /**
   * CR-2026-038 — Auto-apply the make/model suggestion when it is CONFIDENT
   * (HIGH or MEDIUM). Writes the operational serviceClass (+ weightClass) with no
   * manual review, so classification happens automatically. LOW/NONE confidence is
   * left unclassified (serviceClass stays null) → it surfaces in the small
   * "needs review" list and remains mobile-jack blocked (DMAIC Rule 3 fail-safe).
   * No-op if the vehicle already has a real class or is a placeholder. Safe to call
   * from vehicle create / first check-in; actor may be null (system).
   */
  async autoClassify(
    vehicleId: string,
    actorUserId: string | null = null,
  ): Promise<{ applied: boolean; serviceClass?: VehicleServiceClass }> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, vehicleCode: true, make: true, model: true, modelYear: true, serviceClass: true, weightClass: true },
    });
    if (!vehicle || isPlaceholderVehicle(vehicle)) return { applied: false };
    // Never overwrite an already-set real class (only fill nulls / prior UNKNOWN).
    if (vehicle.serviceClass && vehicle.serviceClass !== VehicleServiceClass.UNKNOWN_REQUIRES_REVIEW) {
      return { applied: false };
    }

    const rules = await this.loadRules();
    const suggestion = suggestVehicleClass(
      { make: vehicle.make, model: vehicle.model, modelYear: vehicle.modelYear },
      rules,
    );
    const confident =
      (suggestion.confidence === ClassificationConfidence.HIGH ||
        suggestion.confidence === ClassificationConfidence.MEDIUM) &&
      suggestion.suggestedServiceClass != null;
    if (!confident) return { applied: false }; // leave for the small needs-review list

    const serviceClass = suggestion.suggestedServiceClass as VehicleServiceClass;
    const weightClass = suggestion.suggestedWeightClass ?? vehicle.weightClass ?? null;
    const reviewedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: { serviceClass, ...(weightClass != null && { weightClass }) },
      });
      await tx.vehicleClassification.upsert({
        where: { vehicleId },
        create: {
          vehicleId,
          status: ClassificationStatus.CONFIRMED,
          suggestedServiceClass: suggestion.suggestedServiceClass,
          suggestedWeightClass: suggestion.suggestedWeightClass,
          confidence: suggestion.confidence,
          source: ClassificationSource.MAKE_MODEL_LOOKUP,
          confirmedServiceClass: serviceClass,
          confirmedWeightClass: weightClass,
          reviewedByUserId: actorUserId,
          reviewedAt,
        },
        update: {
          status: ClassificationStatus.CONFIRMED,
          source: ClassificationSource.MAKE_MODEL_LOOKUP,
          confirmedServiceClass: serviceClass,
          confirmedWeightClass: weightClass,
          reviewedByUserId: actorUserId,
          reviewedAt,
        },
      });
    });

    // System auto-classification (actor null) is recorded by the VehicleClassification
    // row (source=MAKE_MODEL_LOOKUP); only write a per-user AuditLog when an actor exists.
    if (actorUserId) {
      await this.audit.log({
        actorUserId,
        action: AUDIT_ACTIONS.VEHICLE_CLASSIFIED,
        entityType: 'Vehicle',
        entityId: vehicleId,
        beforeJson: { serviceClass: vehicle.serviceClass, weightClass: vehicle.weightClass },
        afterJson: { serviceClass, weightClass },
        reasonCode: 'CLASSIFICATION_AUTO_APPLIED',
        notes: `Auto-applied from make/model (${suggestion.confidence})`,
      });
    }

    return { applied: true, serviceClass };
  }

  /**
   * Explicit staff-reviewed bulk accept. Each item carries the class the reviewer
   * chose — there is no blanket auto-acceptance of suggestions. Each item is
   * audited independently; failures are collected, not fatal to the batch.
   */
  async bulkConfirm(
    userId: string,
    items: Array<{ vehicleId: string } & ConfirmClassificationInput>,
  ) {
    const results: Array<{ vehicleId: string; ok: boolean; error?: string }> = [];
    for (const item of items) {
      try {
        await this.confirm(item.vehicleId, userId, item);
        results.push({ vehicleId: item.vehicleId, ok: true });
      } catch (e) {
        results.push({
          vehicleId: item.vehicleId,
          ok: false,
          error: e instanceof Error ? e.message : 'unknown error',
        });
      }
    }
    return {
      confirmed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** Shared audit/status trail for a classification write (queue or check-in). */
  private async writeAuditTrail(
    vehicleId: string,
    userId: string,
    before: { serviceClass: VehicleServiceClass | null; weightClass: VehicleWeightClass | null },
    after: { serviceClass: VehicleServiceClass | null; weightClass: VehicleWeightClass | null },
    notes?: string,
  ) {
    await this.audit.log({
      actorUserId: userId,
      action: AUDIT_ACTIONS.VEHICLE_CLASSIFIED,
      entityType: 'Vehicle',
      entityId: vehicleId,
      beforeJson: before,
      afterJson: after,
      reasonCode: 'CLASSIFICATION_CONFIRMED',
      notes,
    });
    await this.statusHistory.record({
      entityType: 'Vehicle',
      entityId: vehicleId,
      fromStatus: before.serviceClass ?? null,
      toStatus: after.serviceClass ?? 'UNKNOWN_REQUIRES_REVIEW',
      changedByUserId: userId,
      reasonCode: 'CLASSIFICATION_CONFIRMED',
    });
  }
}
