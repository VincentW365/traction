import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, WheelPosition } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { AddRecommendationDto } from './dto/add-recommendation.dto';
import { InspectionQueryDto } from './dto/inspection-query.dto';
import { SignoffInspectionDto } from './dto/signoff-inspection.dto';
import { DecideRecommendationDto } from './dto/decide-recommendation.dto';
import { CustomerSignoffDto } from './dto/customer-signoff.dto';

const ENTITY = 'VehicleInspection';
const ALL_WHEELS: WheelPosition[] = ['LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR', 'RIGHT_REAR'];

export interface InspectionActor {
  sub: string;
  siteId: string | null;
  role: string;
}

const DETAIL_INCLUDE = {
  items: { orderBy: { orderIndex: 'asc' as const } },
  wheelMeasurements: true,
  recommendations: { orderBy: { createdAt: 'asc' as const } },
  signatures: true,
  customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
  vehicle: { select: { id: true, plateNumber: true, make: true, model: true, modelYear: true } },
  serviceVisit: { select: { id: true, status: true } },
} satisfies Prisma.VehicleInspectionInclude;

/**
 * CR-2026-034 — Visual Inspection Form (C-2: API core).
 *
 * State machine DRAFT → COMPLETED → (SIGNED_OFF → CLOSED in C-3); CANCELLED from
 * DRAFT/COMPLETED. Transitions use conditional updateMany (race-safe). Edits are
 * allowed ONLY in DRAFT. StatusHistory + AuditLog written after the status write,
 * entityType='VehicleInspection'. C-2 does not implement sign-off, customer
 * decisions, or approved→work-order (C-3/C-5).
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statusHistory: StatusHistoryService,
  ) {}

  private assertSameSite(siteId: string, actor: InspectionActor): void {
    if (actor.role !== 'ADMIN' && actor.siteId !== siteId) {
      throw new NotFoundException('Inspection not found');
    }
  }

  async create(dto: CreateInspectionDto, actor: InspectionActor) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: dto.serviceVisitId },
      select: { id: true, siteId: true, vehicleId: true, customerId: true },
    });
    if (!visit) throw new BadRequestException(`Service visit ${dto.serviceVisitId} not found`);
    if (!visit.vehicleId) throw new BadRequestException('Service visit has no vehicle to inspect');
    if (actor.role !== 'ADMIN' && actor.siteId !== visit.siteId) {
      throw new ForbiddenException('Cannot create an inspection for another site');
    }

    const template = await this.prisma.inspectionTemplate.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
      include: { items: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!template || template.items.length === 0) {
      throw new BadRequestException('No active inspection template is configured');
    }

    const inspection = await this.prisma.$transaction(async (tx) => {
      const seq = await tx.$queryRaw<{ next_val: number }[]>`
        SELECT COALESCE(MAX(CAST(SUBSTRING(inspection_number FROM 5) AS INTEGER)), 0) + 1 AS next_val
        FROM vehicle_inspections
        WHERE inspection_number ~ '^INS-[0-9]+$'
      `;
      const inspectionNumber = `INS-${String(seq[0].next_val).padStart(6, '0')}`;
      const created = await tx.vehicleInspection.create({
        data: {
          inspectionNumber,
          siteId: visit.siteId,
          serviceVisitId: visit.id,
          vehicleId: visit.vehicleId!,
          customerId: visit.customerId,
          templateId: template.id,
          templateVersion: template.version,
          status: 'DRAFT',
          performedByUserId: actor.sub,
          createdByUserId: actor.sub,
        },
      });
      // Snapshot the active template's lines into immutable per-inspection items.
      await tx.inspectionItem.createMany({
        data: template.items.map((ti) => ({
          inspectionId: created.id,
          category: ti.category,
          label: ti.label,
          orderIndex: ti.orderIndex,
          result: 'OK' as const,
        })),
      });
      // One measurement row per wheel.
      await tx.inspectionWheelMeasurement.createMany({
        data: ALL_WHEELS.map((position) => ({ inspectionId: created.id, position })),
      });
      return created;
    });

    await this.statusHistory.record({ entityType: ENTITY, entityId: inspection.id, fromStatus: null, toStatus: 'DRAFT', changedByUserId: actor.sub });
    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.INSPECTION_CREATED,
      entityType: ENTITY,
      entityId: inspection.id,
      afterJson: { inspectionNumber: inspection.inspectionNumber, serviceVisitId: visit.id, templateVersion: template.version },
      reasonCode: 'INSPECTION_CREATE',
    });

    return this.findById(inspection.id, actor);
  }

  async list(query: InspectionQueryDto, actor: InspectionActor) {
    const take = query.take ?? 50;
    const skip = query.skip ?? 0;
    if (actor.role !== 'ADMIN' && !actor.siteId) {
      return { items: [], total: 0, take, skip };
    }
    const where: Prisma.VehicleInspectionWhereInput = {};
    where.siteId = actor.role === 'ADMIN' ? query.siteId : actor.siteId!;
    if (query.serviceVisitId) where.serviceVisitId = query.serviceVisitId;
    if (query.status) where.status = query.status;

    const [items, total] = await Promise.all([
      this.prisma.vehicleInspection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true, inspectionNumber: true, status: true, createdAt: true, signedOffAt: true,
          customer: { select: { id: true, firstName: true, lastName: true } },
          vehicle: { select: { id: true, plateNumber: true } },
        },
      }),
      this.prisma.vehicleInspection.count({ where }),
    ]);
    return { items, total, take, skip };
  }

  async findById(id: string, actor: InspectionActor) {
    const inspection = await this.prisma.vehicleInspection.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!inspection) throw new NotFoundException('Inspection not found');
    this.assertSameSite(inspection.siteId, actor);
    const timeline = await this.statusHistory.findByEntity(ENTITY, id);
    return { ...inspection, timeline };
  }

  async update(id: string, dto: UpdateInspectionDto, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'DRAFT') throw new BadRequestException('Only DRAFT inspections can be edited');

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.VehicleInspectionUpdateInput = {};
      if (dto.batteryTestResult !== undefined) data.batteryTestResult = dto.batteryTestResult;
      if (dto.batteryFactoryCca !== undefined) data.batteryFactoryCca = dto.batteryFactoryCca;
      if (dto.batteryActualCca !== undefined) data.batteryActualCca = dto.batteryActualCca;
      if (dto.alignmentCheckNeeded !== undefined) data.alignmentCheckNeeded = dto.alignmentCheckNeeded;
      if (dto.wheelBalanceNeeded !== undefined) data.wheelBalanceNeeded = dto.wheelBalanceNeeded;
      if (dto.brakeInspectionPerformed !== undefined) data.brakeInspectionPerformed = dto.brakeInspectionPerformed;
      if (dto.priorBodyDamageNotes !== undefined) data.priorBodyDamageNotes = dto.priorBodyDamageNotes;
      if (dto.comments !== undefined) data.comments = dto.comments;
      if (Object.keys(data).length > 0) await tx.vehicleInspection.update({ where: { id }, data });

      for (const it of dto.items ?? []) {
        // Scope to this inspection so a caller can't edit another inspection's line.
        await tx.inspectionItem.updateMany({
          where: { id: it.itemId, inspectionId: id },
          data: { result: it.result, ...(it.note !== undefined ? { note: it.note } : {}) },
        });
      }
      for (const w of dto.wheels ?? []) {
        await tx.inspectionWheelMeasurement.updateMany({
          where: { inspectionId: id, position: w.position },
          data: {
            ...(w.brakeLiningMm !== undefined ? { brakeLiningMm: w.brakeLiningMm } : {}),
            ...(w.tireTread32nds !== undefined ? { tireTread32nds: w.tireTread32nds } : {}),
            ...(w.wearPattern !== undefined ? { wearPattern: w.wearPattern } : {}),
            ...(w.tirePressureBeforePsi !== undefined ? { tirePressureBeforePsi: w.tirePressureBeforePsi } : {}),
            ...(w.tirePressureAfterPsi !== undefined ? { tirePressureAfterPsi: w.tirePressureAfterPsi } : {}),
            ...(w.rotorOrDrum !== undefined ? { rotorOrDrum: w.rotorOrDrum } : {}),
          },
        });
      }
    });

    return this.findById(id, actor);
  }

  async addRecommendation(id: string, dto: AddRecommendationDto, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'DRAFT') throw new BadRequestException('Recommendations can only be added while DRAFT');

    if (dto.inspectionItemId) {
      const item = await this.prisma.inspectionItem.findFirst({ where: { id: dto.inspectionItemId, inspectionId: id }, select: { id: true } });
      if (!item) throw new BadRequestException('inspectionItemId does not belong to this inspection');
    }

    return this.prisma.inspectionRecommendation.create({
      data: {
        inspectionId: id,
        inspectionItemId: dto.inspectionItemId ?? null,
        severity: dto.severity,
        description: dto.description,
        suggestedServiceTypeCode: dto.suggestedServiceTypeCode ?? null,
      },
    });
  }

  async complete(id: string, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);

    const { count } = await this.prisma.vehicleInspection.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'COMPLETED' } });
    if (count === 0) throw new BadRequestException('Inspection is not DRAFT');

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'DRAFT', toStatus: 'COMPLETED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_COMPLETED, entityType: ENTITY, entityId: id, afterJson: { status: 'COMPLETED' }, reasonCode: 'INSPECTION_COMPLETE' });

    return this.findById(id, actor);
  }

  async cancel(id: string, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);

    const { count } = await this.prisma.vehicleInspection.updateMany({
      where: { id, status: { in: ['DRAFT', 'COMPLETED'] } },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) throw new BadRequestException('Only DRAFT or COMPLETED inspections can be cancelled');

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: existing.status, toStatus: 'CANCELLED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_CANCELLED, entityType: ENTITY, entityId: id, beforeJson: { status: existing.status }, afterJson: { status: 'CANCELLED' }, reasonCode: 'INSPECTION_CANCEL' });

    return this.findById(id, actor);
  }

  // ─── C-3: sign-off + customer decisions (results are immutable once SIGNED_OFF — the
  // DRAFT-only guards on update()/addRecommendation() enforce that) ────────────

  /** Senior-tech sign-off: COMPLETED → SIGNED_OFF + typed acknowledgment signature. */
  async signoff(id: string, actor: InspectionActor, dto: SignoffInspectionDto) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    const typedName = dto.typedName?.trim();
    if (!typedName) throw new BadRequestException('A typed acknowledgment name is required to sign off');

    // Status flip + signature are atomic; the conditional updateMany is the race guard.
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicleInspection.updateMany({
        where: { id, status: 'COMPLETED' },
        data: { status: 'SIGNED_OFF', signedOffByUserId: actor.sub, signedOffAt: new Date() },
      });
      if (count === 0) throw new BadRequestException('Inspection must be COMPLETED to sign off');
      await tx.inspectionSignature.create({
        data: { inspectionId: id, role: 'SENIOR_TECH', type: 'TYPED', typedName, signedByUserId: actor.sub },
      });
    });

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'COMPLETED', toStatus: 'SIGNED_OFF', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_SIGNED_OFF, entityType: ENTITY, entityId: id, afterJson: { status: 'SIGNED_OFF' }, reasonCode: 'INSPECTION_SIGNOFF' });
    return this.findById(id, actor);
  }

  /** Record the customer's decision on a recommendation (only while SIGNED_OFF). */
  async decideRecommendation(id: string, recommendationId: string, actor: InspectionActor, dto: DecideRecommendationDto) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'SIGNED_OFF') throw new BadRequestException('Decisions can only be recorded after sign-off and before close');

    const rec = await this.prisma.inspectionRecommendation.findFirst({ where: { id: recommendationId, inspectionId: id }, select: { id: true } });
    if (!rec) throw new NotFoundException('Recommendation not found for this inspection');

    const updated = await this.prisma.inspectionRecommendation.update({
      where: { id: recommendationId },
      data: { customerDecision: dto.decision, decisionByUserId: actor.sub, decisionAt: new Date() },
    });
    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.INSPECTION_RECOMMENDATION_DECISION,
      entityType: ENTITY,
      entityId: id,
      afterJson: { recommendationId, decision: dto.decision },
      reasonCode: 'INSPECTION_REC_DECISION',
    });
    return updated;
  }

  /** Customer sign-off: SIGNED_OFF → CLOSED + customer signature (drawn or typed). */
  async customerSignoff(id: string, actor: InspectionActor, dto: CustomerSignoffDto) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    const typedName = dto.typedName?.trim();
    if (dto.type === 'DRAWN' && !dto.imageData) throw new BadRequestException('A drawn signature image is required');
    if (dto.type === 'TYPED' && !typedName) throw new BadRequestException('A typed name is required');

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicleInspection.updateMany({
        where: { id, status: 'SIGNED_OFF' },
        data: { status: 'CLOSED', customerAckByUserId: actor.sub, customerAckAt: new Date() },
      });
      if (count === 0) throw new BadRequestException('Inspection must be SIGNED_OFF before customer sign-off');
      await tx.inspectionSignature.create({
        data: {
          inspectionId: id,
          role: 'CUSTOMER',
          type: dto.type,
          typedName: dto.type === 'TYPED' ? typedName : null,
          imageData: dto.type === 'DRAWN' ? dto.imageData : null,
          signedByUserId: actor.sub,
        },
      });
    });

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'SIGNED_OFF', toStatus: 'CLOSED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_CUSTOMER_SIGNED, entityType: ENTITY, entityId: id, afterJson: { status: 'CLOSED', signatureType: dto.type }, reasonCode: 'INSPECTION_CUSTOMER_SIGNOFF' });
    return this.findById(id, actor);
  }
}
