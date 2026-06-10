import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  VehicleServiceClass,
  VehicleWeightClass,
  ClassificationStatus,
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
   */
  async getQueue(limit = 50) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { serviceClass: null, ...liveVehicleWhere(false) },
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
      take: limit,
      orderBy: { updatedAt: 'desc' },
    });

    const rules = await this.loadRules();

    return vehicles.map((v) => {
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
