import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, ComplaintSeverity } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { UpdateComplaintDto } from './dto/update-complaint.dto';
import { ResolveComplaintDto } from './dto/resolve-complaint.dto';
import { ComplaintQueryDto } from './dto/complaint-query.dto';

const ENTITY = 'Complaint';
/** In-code fallback when no BusinessRuleConfig row exists (config can override). */
const DEFAULT_SLA_HOURS: Record<string, number> = { LOW: 120, MEDIUM: 72, HIGH: 24, CRITICAL: 4 };

/** Minimal actor shape sourced from the JWT (never from a DTO). */
export interface ComplaintActor {
  sub: string;
  siteId: string | null;
  role: string;
}

/**
 * CR-2026-032 — Customer Complaints Log.
 *
 * State machine OPEN → ACKNOWLEDGED → RESOLVED (acknowledge optional). Transitions
 * use conditional updateMany (DB enforces the guard → race-safe, exactly one
 * history/audit row per real transition). StatusHistory + AuditLog are written
 * AFTER the status write — matching every existing service (AuditService /
 * StatusHistoryService take no tx client). RESOLVED is terminal.
 */
@Injectable()
export class ComplaintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statusHistory: StatusHistoryService,
  ) {}

  private async slaHoursFor(severity: ComplaintSeverity): Promise<number> {
    const row = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'complaint_sla_hours_by_severity', effectiveTo: null },
    });
    const map = (row?.valueJson as Record<string, number> | undefined) ?? DEFAULT_SLA_HOURS;
    return map[severity] ?? DEFAULT_SLA_HOURS[severity] ?? DEFAULT_SLA_HOURS.MEDIUM;
  }

  private slaDueAt(createdAt: Date, hours: number): Date {
    return new Date(createdAt.getTime() + hours * 3_600_000);
  }

  /** Cross-site guard for by-id ops (SiteGuard is a no-op without a siteId in the request). ADMIN bypasses. */
  private assertSameSite(complaintSiteId: string, actor: ComplaintActor): void {
    if (actor.role !== 'ADMIN' && actor.siteId !== complaintSiteId) {
      throw new NotFoundException('Complaint not found');
    }
  }

  async create(dto: CreateComplaintDto, actor: ComplaintActor) {
    // Validate referenced entities BEFORE any write.
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, select: { id: true } });
    if (!customer) throw new BadRequestException(`Customer ${dto.customerId} not found`);
    const site = await this.prisma.site.findUnique({ where: { id: dto.siteId }, select: { id: true } });
    if (!site) throw new BadRequestException(`Site ${dto.siteId} not found`);
    if (dto.serviceVisitId) {
      const v = await this.prisma.serviceVisit.findUnique({ where: { id: dto.serviceVisitId }, select: { id: true } });
      if (!v) throw new BadRequestException(`Service visit ${dto.serviceVisitId} not found`);
    }
    if (dto.serviceOrderId) {
      const o = await this.prisma.serviceOrder.findUnique({ where: { id: dto.serviceOrderId }, select: { id: true } });
      if (!o) throw new BadRequestException(`Service order ${dto.serviceOrderId} not found`);
    }

    const severity = dto.severity ?? ComplaintSeverity.MEDIUM;
    const hours = await this.slaHoursFor(severity);

    // CMP-NNNNNN generated INSIDE the create tx (mirrors customers.service.ts); @unique is the race backstop.
    const complaint = await this.prisma.$transaction(async (tx) => {
      const seq = await tx.$queryRaw<{ next_val: number }[]>`
        SELECT COALESCE(MAX(CAST(SUBSTRING(complaint_number FROM 5) AS INTEGER)), 0) + 1 AS next_val
        FROM complaints
        WHERE complaint_number ~ '^CMP-[0-9]+$'
      `;
      const complaintNumber = `CMP-${String(seq[0].next_val).padStart(6, '0')}`;
      const now = new Date();
      return tx.complaint.create({
        data: {
          complaintNumber,
          siteId: dto.siteId,
          customerId: dto.customerId,
          serviceVisitId: dto.serviceVisitId ?? null,
          serviceOrderId: dto.serviceOrderId ?? null,
          type: dto.type,
          severity,
          status: 'OPEN',
          subject: dto.subject,
          description: dto.description,
          slaDueAt: this.slaDueAt(now, hours),
          createdByUserId: actor.sub,
        },
      });
    });

    await this.statusHistory.record({
      entityType: ENTITY,
      entityId: complaint.id,
      fromStatus: null,
      toStatus: 'OPEN',
      changedByUserId: actor.sub,
    });
    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.COMPLAINT_CREATED,
      entityType: ENTITY,
      entityId: complaint.id,
      afterJson: { complaintNumber: complaint.complaintNumber, type: complaint.type, severity: complaint.severity, status: 'OPEN' },
      reasonCode: 'COMPLAINT_CREATE',
    });

    return complaint;
  }

  async list(query: ComplaintQueryDto, actor: ComplaintActor) {
    const take = query.take ?? 50;
    const skip = query.skip ?? 0;

    // Non-ADMIN is locked to their own site; a non-admin with no site sees nothing.
    if (actor.role !== 'ADMIN' && !actor.siteId) {
      return { items: [], total: 0, take, skip };
    }
    const where: Prisma.ComplaintWhereInput = {};
    where.siteId = actor.role === 'ADMIN' ? query.siteId : actor.siteId!;
    if (query.status) where.status = query.status;
    if (query.severity) where.severity = query.severity;
    if (query.type) where.type = query.type;
    if (query.customerId) where.customerId = query.customerId;

    const [items, total] = await Promise.all([
      this.prisma.complaint.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true } },
          serviceVisit: { select: { id: true, status: true } },
          serviceOrder: { select: { id: true, status: true } },
        },
      }),
      this.prisma.complaint.count({ where }),
    ]);
    return { items, total, take, skip };
  }

  async findById(id: string, actor: ComplaintActor) {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        serviceVisit: { select: { id: true, status: true } },
        serviceOrder: { select: { id: true, status: true } },
      },
    });
    if (!complaint) throw new NotFoundException('Complaint not found');
    this.assertSameSite(complaint.siteId, actor);
    const timeline = await this.statusHistory.findByEntity(ENTITY, id);
    return { ...complaint, timeline };
  }

  async acknowledge(id: string, actor: ComplaintActor, notes?: string) {
    const existing = await this.prisma.complaint.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Complaint not found');
    this.assertSameSite(existing.siteId, actor);

    // Conditional write → the DB enforces "must be OPEN"; concurrent calls: exactly one wins.
    const { count } = await this.prisma.complaint.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedByUserId: actor.sub },
    });
    if (count === 0) throw new BadRequestException('Complaint is not OPEN');

    const note = notes?.trim() || undefined;
    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'OPEN', toStatus: 'ACKNOWLEDGED', changedByUserId: actor.sub, notes: note });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.COMPLAINT_ACKNOWLEDGED, entityType: ENTITY, entityId: id, afterJson: { status: 'ACKNOWLEDGED' }, reasonCode: 'COMPLAINT_ACKNOWLEDGE', notes: note });

    return this.prisma.complaint.findUnique({ where: { id } });
  }

  async resolve(id: string, actor: ComplaintActor, dto: ResolveComplaintDto) {
    const resolutionNotes = dto.resolutionNotes?.trim();
    if (!resolutionNotes) throw new BadRequestException('resolutionNotes is required to resolve a complaint');

    const existing = await this.prisma.complaint.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Complaint not found');
    this.assertSameSite(existing.siteId, actor);

    // Conditional write → only OPEN/ACKNOWLEDGED can resolve; concurrent resolves: exactly one wins.
    const { count } = await this.prisma.complaint.updateMany({
      where: { id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: actor.sub, resolutionNotes },
    });
    if (count === 0) throw new BadRequestException('Complaint is already RESOLVED');

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: existing.status, toStatus: 'RESOLVED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.COMPLAINT_RESOLVED, entityType: ENTITY, entityId: id, beforeJson: { status: existing.status }, afterJson: { status: 'RESOLVED' }, reasonCode: 'COMPLAINT_RESOLVE' });

    return this.prisma.complaint.findUnique({ where: { id } });
  }

  async update(id: string, dto: UpdateComplaintDto, actor: ComplaintActor) {
    const existing = await this.prisma.complaint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Complaint not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status === 'RESOLVED') throw new BadRequestException('Cannot edit a RESOLVED complaint');

    const data: Prisma.ComplaintUpdateInput = {};
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.subject !== undefined) data.subject = dto.subject;
    if (dto.description !== undefined) data.description = dto.description;

    let slaChanged = false;
    if (dto.severity !== undefined) {
      data.severity = dto.severity;
      if (dto.severity !== existing.severity) {
        // Recompute SLA anchored to the ORIGINAL createdAt (never now()).
        const hours = await this.slaHoursFor(dto.severity);
        data.slaDueAt = this.slaDueAt(existing.createdAt, hours);
        slaChanged = true;
      }
    }

    const updated = await this.prisma.complaint.update({ where: { id }, data });

    // PATCH is NOT a status transition → no StatusHistory row; audit only.
    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.COMPLAINT_UPDATED,
      entityType: ENTITY,
      entityId: id,
      beforeJson: { type: existing.type, severity: existing.severity, subject: existing.subject, ...(slaChanged ? { slaDueAt: existing.slaDueAt } : {}) },
      afterJson: { type: updated.type, severity: updated.severity, subject: updated.subject, ...(slaChanged ? { slaDueAt: updated.slaDueAt } : {}) },
      reasonCode: 'COMPLAINT_UPDATE',
    });

    return updated;
  }
}
