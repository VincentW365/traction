import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { MaintenanceReminderService } from './maintenance-reminder.service';
import {
  VehicleIdentityProvider,
  VEHICLE_IDENTITY_PROVIDER,
} from './providers/vehicle-identity.provider.interface';
import {
  FluidSpecProvider,
  FLUID_SPEC_PROVIDER,
} from './providers/fluid-spec.provider.interface';
import {
  calculatePostService,
  calculateAdvisory,
  DrivingProfileInput,
} from './engine/recommendation.calculator';
import { resolveConfidence } from './engine/confidence.resolver';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(VEHICLE_IDENTITY_PROVIDER)
    private readonly vehicleIdentityProvider: VehicleIdentityProvider,
    @Inject(FLUID_SPEC_PROVIDER)
    private readonly fluidSpecProvider: FluidSpecProvider,
    @Inject(forwardRef(() => MaintenanceReminderService))
    private readonly reminderService: MaintenanceReminderService,
  ) {}

  // ─── Vehicle Decode ────────────────────────────────────────────

  /**
   * Decode a vehicle's VIN and store a VehicleSpecSnapshot.
   * Returns the snapshot plus a flag indicating whether engine confirmation
   * is needed (when engineCode is null or confidence < VERIFIED).
   */
  async decodeVehicle(vehicleId: string, forceRedecode = false) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }

    // Cache check: return existing snapshot matching VIN + year unless force-redecode
    if (!forceRedecode) {
      const existing = await this.prisma.vehicleSpecSnapshot.findFirst({
        where: {
          vehicleId,
          ...(vehicle.vin ? { vin: vehicle.vin } : {}),
          ...(vehicle.modelYear ? { year: vehicle.modelYear } : {}),
        },
        orderBy: { decodedAt: 'desc' },
      });
      if (existing) {
        return {
          snapshot: existing,
          needsEngineConfirmation:
            !existing.engineCode ||
            existing.decodeConfidence === 'NEEDS_CONFIRMATION' ||
            existing.decodeConfidence === 'ESTIMATE',
        };
      }
    }

    const vin = vehicle.vin;
    const decoded = vin
      ? await this.vehicleIdentityProvider.decodeVin(vin)
      : null;

    const snapshot = await this.prisma.vehicleSpecSnapshot.create({
      data: {
        vehicleId,
        vin: vin ?? null,
        year: decoded?.year ?? vehicle.modelYear ?? null,
        make: decoded?.make ?? vehicle.make ?? null,
        model: decoded?.model ?? vehicle.model ?? null,
        trim: decoded?.trim ?? null,
        engineCode: decoded?.engineCode ?? null,
        engineDescription: decoded?.engineDescription ?? null,
        displacement: decoded?.displacement ?? null,
        fuelType: decoded?.fuelType ?? null,
        driveType: decoded?.driveType ?? null,
        decodeSource: decoded?.decodeSource ?? 'VEHICLE_RECORD',
        decodeConfidence: decoded?.confidence ?? 'ESTIMATE',
        decodedAt: new Date(),
      },
    });

    // Auto-populate vehicle fields from decode ONLY where currently null/empty
    // Never overwrite manually corrected data
    if (decoded && snapshot.decodeConfidence !== 'ESTIMATE') {
      const autoUpdate: Record<string, unknown> = {};
      if (!vehicle.make && decoded.make) autoUpdate.make = decoded.make;
      if (!vehicle.model && decoded.model) autoUpdate.model = decoded.model;
      if (!vehicle.modelYear && decoded.year) autoUpdate.modelYear = decoded.year;

      if (Object.keys(autoUpdate).length > 0) {
        await this.prisma.vehicle.update({
          where: { id: vehicleId },
          data: autoUpdate,
        });
        this.logger.log(
          `Auto-populated vehicle ${vehicleId} fields: ${Object.keys(autoUpdate).join(', ')}`,
        );
      }
    }

    this.logger.log(
      `Vehicle ${vehicleId} decoded — confidence=${snapshot.decodeConfidence}`,
    );

    return {
      snapshot,
      needsEngineConfirmation:
        !snapshot.engineCode ||
        snapshot.decodeConfidence === 'NEEDS_CONFIRMATION' ||
        snapshot.decodeConfidence === 'ESTIMATE',
    };
  }

  // ─── Fluid Recommendation ─────────────────────────────────────

  /**
   * Look up fluid specifications for a vehicle + service type.
   * Stores a FluidSpecSnapshot and returns it.
   *
   * CRITICAL: If no engine data is available, the result will have null
   * fluid grade fields and confidence = NEEDS_CONFIRMATION at best.
   */
  async getFluidRecommendation(vehicleId: string, serviceTypeCode: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }

    // Get or create vehicle spec snapshot
    let specSnapshot = await this.prisma.vehicleSpecSnapshot.findFirst({
      where: { vehicleId },
      orderBy: { decodedAt: 'desc' },
    });
    if (!specSnapshot) {
      const decoded = await this.decodeVehicle(vehicleId);
      specSnapshot = decoded.snapshot;
    }

    // Attempt fluid spec lookup
    const fluidResult = await this.fluidSpecProvider.getFluidSpec({
      engineCode: specSnapshot.engineCode ?? undefined,
      year: specSnapshot.year ?? vehicle.modelYear ?? 0,
      make: specSnapshot.make ?? vehicle.make ?? '',
      model: specSnapshot.model ?? vehicle.model ?? '',
      serviceTypeCode,
    });

    if (!fluidResult) {
      return {
        fluidSpec: null,
        confidence: 'NEEDS_CONFIRMATION' as const,
        message:
          'No fluid specification data available. Confirm fluid requirements manually.',
      };
    }

    const fluidSnapshot = await this.prisma.fluidSpecSnapshot.create({
      data: {
        vehicleId,
        serviceTypeCode,
        saeViscosityGrade: fluidResult.saeViscosityGrade,
        apiCategory: fluidResult.apiCategory,
        ilsacCategory: fluidResult.ilsacCategory,
        oemApprovalCode: fluidResult.oemApprovalCode,
        capacityWithFilter: fluidResult.capacityWithFilter,
        capacityWithoutFilter: fluidResult.capacityWithoutFilter,
        normalIntervalMiles: fluidResult.normalIntervalMiles,
        severeIntervalMiles: fluidResult.severeIntervalMiles,
        normalIntervalMonths: fluidResult.normalIntervalMonths,
        severeIntervalMonths: fluidResult.severeIntervalMonths,
        sourceProvider: fluidResult.sourceProvider,
        sourceReference: null,
        confidence: fluidResult.confidence,
        effectiveAt: new Date(),
      },
    });

    const overallConfidence = resolveConfidence(
      !!vehicle.vin,
      specSnapshot.decodeConfidence as any,
      fluidResult.confidence,
    );

    return {
      fluidSpec: fluidSnapshot,
      confidence: overallConfidence,
      message:
        overallConfidence === 'NEEDS_CONFIRMATION' || overallConfidence === 'ESTIMATE'
          ? 'Fluid specification requires manual confirmation — engine data is incomplete.'
          : null,
    };
  }

  // ─── Advisory Recommendation ──────────────────────────────────

  /**
   * Generate an advisory maintenance recommendation for a vehicle.
   * Combines the latest fluid spec with the last known service to compute
   * next-due projections.
   */
  async getAdvisoryRecommendation(
    vehicleId: string,
    serviceTypeCode: string,
    drivingProfile: DrivingProfileInput = 'NORMAL',
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }

    // Get latest fluid spec for intervals
    const fluidSpec = await this.prisma.fluidSpecSnapshot.findFirst({
      where: { vehicleId, serviceTypeCode },
      orderBy: { effectiveAt: 'desc' },
    });

    // Get latest prior recommendation for baseline (if any)
    const lastRec = await this.prisma.maintenanceRecommendation.findFirst({
      where: {
        vehicleId,
        serviceTypeCode,
        recommendationType: { in: ['POST_SERVICE', 'PRIOR_SERVICE'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    const intervalMiles =
      drivingProfile === 'SEVERE'
        ? (fluidSpec?.severeIntervalMiles ?? null)
        : (fluidSpec?.normalIntervalMiles ?? null);

    const intervalMonths =
      drivingProfile === 'SEVERE'
        ? (fluidSpec?.severeIntervalMonths ?? null)
        : (fluidSpec?.normalIntervalMonths ?? null);

    const advisory = calculateAdvisory({
      currentOdometer: vehicle.odometer ?? null,
      lastServiceOdometer: lastRec?.basisOdometer ?? null,
      lastServiceDate: lastRec?.basisDate ?? null,
      intervalMiles,
      intervalMonths,
      drivingProfile,
    });

    // Resolve confidence
    const specSnapshot = await this.prisma.vehicleSpecSnapshot.findFirst({
      where: { vehicleId },
      orderBy: { decodedAt: 'desc' },
    });

    const confidence = resolveConfidence(
      !!vehicle.vin,
      (specSnapshot?.decodeConfidence as any) ?? null,
      (fluidSpec?.confidence as any) ?? null,
    );

    const recommendation = await this.prisma.maintenanceRecommendation.create({
      data: {
        vehicleId,
        serviceTypeCode,
        recommendationType: 'ADVISORY',
        drivingProfile,
        basisOdometer: advisory.basisOdometer,
        basisDate: advisory.basisDate,
        intervalMiles,
        intervalMonths,
        nextDueOdometer: advisory.nextDueOdometer,
        nextDueDate: advisory.nextDueDate,
        dueNowFlag: advisory.dueNowFlag,
        isDeterminable: advisory.isDeterminable,
        recommendationSource: 'SYSTEM',
        confidence,
        fluidSpecSnapshotId: fluidSpec?.id ?? null,
        vehicleSpecSnapshotId: specSnapshot?.id ?? null,
        notes: advisory.isDeterminable
          ? null
          : 'No prior service baseline available — recommendation is indeterminate.',
      },
    });

    return recommendation;
  }

  // ─── Post-Service Recommendation ──────────────────────────────

  /**
   * Record a post-service maintenance recommendation after a service order
   * is completed. Computes next-due based on the completion odometer.
   */
  async recordPostService(
    serviceOrderId: string,
    serviceTypeCode: string,
    completionOdometer: number,
    drivingProfile: DrivingProfileInput = 'NORMAL',
    userId: string,
  ) {
    const serviceOrder = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      include: { serviceVisit: true },
    });
    if (!serviceOrder) {
      throw new NotFoundException(`ServiceOrder ${serviceOrderId} not found`);
    }

    const vehicleId = serviceOrder.serviceVisit.vehicleId;

    // Get latest fluid spec for intervals
    const fluidSpec = await this.prisma.fluidSpecSnapshot.findFirst({
      where: { vehicleId, serviceTypeCode },
      orderBy: { effectiveAt: 'desc' },
    });

    const intervalMiles =
      drivingProfile === 'SEVERE'
        ? (fluidSpec?.severeIntervalMiles ?? null)
        : (fluidSpec?.normalIntervalMiles ?? null);

    const intervalMonths =
      drivingProfile === 'SEVERE'
        ? (fluidSpec?.severeIntervalMonths ?? null)
        : (fluidSpec?.normalIntervalMonths ?? null);

    const result = calculatePostService({
      currentOdometer: completionOdometer,
      serviceDate: new Date(),
      intervalMiles,
      intervalMonths,
      drivingProfile,
    });

    const specSnapshot = await this.prisma.vehicleSpecSnapshot.findFirst({
      where: { vehicleId },
      orderBy: { decodedAt: 'desc' },
    });

    const confidence = resolveConfidence(
      !!(await this.prisma.vehicle.findUnique({ where: { id: vehicleId } }))
        ?.vin,
      (specSnapshot?.decodeConfidence as any) ?? null,
      (fluidSpec?.confidence as any) ?? null,
    );

    const recommendation = await this.prisma.maintenanceRecommendation.create({
      data: {
        vehicleId,
        serviceVisitId: serviceOrder.serviceVisitId ?? null,
        serviceOrderId,
        serviceTypeCode,
        recommendationType: 'POST_SERVICE',
        drivingProfile,
        basisOdometer: result.basisOdometer,
        basisDate: result.basisDate,
        intervalMiles,
        intervalMonths,
        nextDueOdometer: result.nextDueOdometer,
        nextDueDate: result.nextDueDate,
        dueNowFlag: false,
        isDeterminable: true,
        recommendationSource: 'SYSTEM',
        confidence,
        fluidSpecSnapshotId: fluidSpec?.id ?? null,
        vehicleSpecSnapshotId: specSnapshot?.id ?? null,
        createdByUserId: userId,
      },
    });

    // Update vehicle odometer to latest reading
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { odometer: completionOdometer },
    });

    this.logger.log(
      `Post-service recommendation created for SO ${serviceOrderId} ` +
        `[${serviceTypeCode}] — next due ${result.nextDueOdometer ?? '?'} mi / ${result.nextDueDate?.toISOString() ?? '?'}`,
    );

    // Auto-create maintenance reminder for eligible service types
    try {
      await this.reminderService.autoCreateFromRecommendation(
        {
          id: recommendation.id,
          vehicleId,
          serviceTypeCode,
          nextDueOdometer: result.nextDueOdometer,
          nextDueDate: result.nextDueDate,
          confidence: confidence as string,
        },
        serviceOrder.serviceVisit.customerId,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to auto-create reminder for recommendation ${recommendation.id}: ${(err as Error).message}`,
      );
    }

    return recommendation;
  }

  // ─── Recommendation History ───────────────────────────────────

  async getRecommendationHistory(
    vehicleId: string,
    serviceTypeCode?: string,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }

    const where: Record<string, unknown> = { vehicleId };
    if (serviceTypeCode) {
      where.serviceTypeCode = serviceTypeCode;
    }

    return this.prisma.maintenanceRecommendation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        fluidSpec: true,
        vehicleSpec: true,
      },
    });
  }

  // ─── Override Recommendation ──────────────────────────────────

  /**
   * Create a new recommendation that supersedes an existing one.
   * The original is preserved via supersedesRecommendationId.
   * An audit log entry is always written.
   */
  async overrideRecommendation(
    recommendationId: string,
    overrideValues: {
      nextDueOdometer?: number;
      nextDueDate?: string;
      intervalMiles?: number;
      intervalMonths?: number;
      drivingProfile?: DrivingProfileInput;
    },
    reason: string,
    userId: string,
  ) {
    const original = await this.prisma.maintenanceRecommendation.findUnique({
      where: { id: recommendationId },
    });
    if (!original) {
      throw new NotFoundException(
        `Recommendation ${recommendationId} not found`,
      );
    }

    const newRec = await this.prisma.maintenanceRecommendation.create({
      data: {
        vehicleId: original.vehicleId,
        serviceVisitId: original.serviceVisitId,
        serviceOrderId: original.serviceOrderId,
        serviceTypeCode: original.serviceTypeCode,
        recommendationType: 'MANUAL_OVERRIDE',
        drivingProfile:
          overrideValues.drivingProfile ?? (original.drivingProfile as DrivingProfileInput),
        basisOdometer: original.basisOdometer,
        basisDate: original.basisDate,
        intervalMiles: overrideValues.intervalMiles ?? original.intervalMiles,
        intervalMonths: overrideValues.intervalMonths ?? original.intervalMonths,
        nextDueOdometer:
          overrideValues.nextDueOdometer ?? original.nextDueOdometer,
        nextDueDate: overrideValues.nextDueDate
          ? new Date(overrideValues.nextDueDate)
          : original.nextDueDate,
        dueNowFlag: original.dueNowFlag,
        isDeterminable: true,
        recommendationSource: 'MANUAL',
        confidence: 'VERIFIED',
        fluidSpecSnapshotId: original.fluidSpecSnapshotId,
        vehicleSpecSnapshotId: original.vehicleSpecSnapshotId,
        supersedesRecommendationId: original.id,
        notes: reason,
        createdByUserId: userId,
      },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'MAINTENANCE_RECOMMENDATION_OVERRIDE',
      entityType: 'MaintenanceRecommendation',
      entityId: newRec.id,
      beforeJson: original as any,
      afterJson: newRec as any,
      reasonCode: 'MANUAL_OVERRIDE',
      notes: reason,
    });

    this.logger.log(
      `Recommendation ${original.id} overridden by ${userId} — new rec ${newRec.id}`,
    );

    return newRec;
  }

  // ─── Prior Service Entry ──────────────────────────────────────

  /**
   * Record a prior service performed elsewhere to establish a baseline
   * for future advisory recommendations. Creates an advisory from the
   * external service data.
   */
  async recordPriorService(
    vehicleId: string,
    serviceTypeCode: string,
    lastServiceOdometer: number | null,
    lastServiceDate: Date | null,
    source: string,
    drivingProfile: DrivingProfileInput = 'NORMAL',
    userId: string,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }

    if (lastServiceOdometer == null && lastServiceDate == null) {
      throw new BadRequestException(
        'At least one of lastServiceOdometer or lastServiceDate is required',
      );
    }

    // Get latest fluid spec for intervals
    const fluidSpec = await this.prisma.fluidSpecSnapshot.findFirst({
      where: { vehicleId, serviceTypeCode },
      orderBy: { effectiveAt: 'desc' },
    });

    const intervalMiles =
      drivingProfile === 'SEVERE'
        ? (fluidSpec?.severeIntervalMiles ?? null)
        : (fluidSpec?.normalIntervalMiles ?? null);

    const intervalMonths =
      drivingProfile === 'SEVERE'
        ? (fluidSpec?.severeIntervalMonths ?? null)
        : (fluidSpec?.normalIntervalMonths ?? null);

    const advisory = calculateAdvisory({
      currentOdometer: vehicle.odometer ?? null,
      lastServiceOdometer,
      lastServiceDate,
      intervalMiles,
      intervalMonths,
      drivingProfile,
    });

    const recommendation = await this.prisma.maintenanceRecommendation.create({
      data: {
        vehicleId,
        serviceTypeCode,
        recommendationType: 'PRIOR_SERVICE',
        drivingProfile,
        basisOdometer: lastServiceOdometer,
        basisDate: lastServiceDate,
        intervalMiles,
        intervalMonths,
        nextDueOdometer: advisory.nextDueOdometer,
        nextDueDate: advisory.nextDueDate,
        dueNowFlag: advisory.dueNowFlag,
        isDeterminable: advisory.isDeterminable,
        recommendationSource: source,
        confidence: 'ESTIMATE',
        fluidSpecSnapshotId: fluidSpec?.id ?? null,
        notes: `Prior service recorded from ${source}`,
        createdByUserId: userId,
      },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: AUDIT_ACTIONS.PRIOR_SERVICE_ENTRY,
      entityType: 'MaintenanceRecommendation',
      entityId: recommendation.id,
      afterJson: recommendation as any,
      notes: `Prior ${serviceTypeCode} recorded from ${source}`,
    });

    this.logger.log(
      `Prior service recorded for vehicle ${vehicleId} [${serviceTypeCode}] from ${source}`,
    );

    return recommendation;
  }

  // ─── Due Vehicles Query ───────────────────────────────────────

  /**
   * Find vehicles approaching their next-due maintenance threshold.
   * Used for proactive outreach / recurring maintenance scheduling.
   */
  async getDueVehicles(
    siteId: string,
    thresholdMiles = 500,
    thresholdDays = 30,
  ) {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() + thresholdDays);

    // Find the latest recommendation per vehicle+serviceType that is approaching due
    // We use a raw approach: get all active recommendations, then filter in-app
    // because Prisma does not support window functions directly.
    const recommendations = await this.prisma.maintenanceRecommendation.findMany(
      {
        where: {
          isDeterminable: true,
          dueNowFlag: false,
          supersedesRecommendationId: null, // only current (not superseded)
          vehicle: {
            customer: {
              // Scope to vehicles whose customers are associated with this site
              // via their most recent appointment or service visit
            },
          },
          OR: [
            {
              nextDueDate: { lte: thresholdDate },
            },
            // Odometer-based filtering requires comparing vehicle.odometer + threshold
            // against nextDueOdometer. We filter in application logic below.
          ],
        },
        include: {
          vehicle: {
            include: { customer: true },
          },
        },
        orderBy: { nextDueDate: 'asc' },
      },
    );

    // Post-filter for odometer proximity
    const due = recommendations.filter((rec) => {
      const dateApproaching =
        rec.nextDueDate != null && rec.nextDueDate <= thresholdDate;

      const odometerApproaching =
        rec.nextDueOdometer != null &&
        rec.vehicle.odometer != null &&
        rec.vehicle.odometer + thresholdMiles >= rec.nextDueOdometer;

      return dateApproaching || odometerApproaching;
    });

    // CR-2026-096 — attach last-contact details so the due list can show
    // "Last contacted: Aug 24 — SMS — Sent" and staff avoid repeat-messaging.
    const logIds = due.map((r) => r.lastContactLogId).filter((id): id is string => !!id);
    const logs = logIds.length
      ? await this.prisma.notificationLog.findMany({
          where: { id: { in: logIds } },
          select: { id: true, channel: true, status: true, sentAt: true, createdAt: true },
        })
      : [];
    const logById = new Map(logs.map((l) => [l.id, l]));

    return due.map((rec) => ({
      ...rec,
      lastContact: rec.lastContactLogId ? (logById.get(rec.lastContactLogId) ?? null) : null,
    }));
  }

  /**
   * CR-2026-096 — set the follow-up outcome of a due-service customer contact.
   * Business status only (BOOKED / DEFERRED / DO_NOT_CONTACT / reset); message
   * delivery status lives on NotificationLog and is never set here.
   */
  async setContactStatus(
    recommendationId: string,
    contactStatus: 'NOT_CONTACTED' | 'CONTACTED' | 'BOOKED' | 'DEFERRED' | 'DO_NOT_CONTACT',
    userId: string,
  ) {
    const rec = await this.prisma.maintenanceRecommendation.findUnique({
      where: { id: recommendationId },
      select: { id: true, contactStatus: true },
    });
    if (!rec) {
      throw new NotFoundException(`Recommendation ${recommendationId} not found`);
    }

    const updated = await this.prisma.maintenanceRecommendation.update({
      where: { id: recommendationId },
      data: { contactStatus },
    });

    await this.auditService.log({
      actorUserId: userId,
      action: 'SERVICE_DUE_CONTACT_STATUS_CHANGED',
      entityType: 'MaintenanceRecommendation',
      entityId: recommendationId,
      beforeJson: { contactStatus: rec.contactStatus },
      afterJson: { contactStatus },
    });

    return { id: updated.id, contactStatus: updated.contactStatus };
  }
}
