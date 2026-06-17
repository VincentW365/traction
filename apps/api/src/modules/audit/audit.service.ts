import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface LogAuditInput {
  // null = system-initiated event (no human actor). The AuditLog.actorUserId
  // column is nullable, so system transitions are still fully audited.
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  beforeJson?: object;
  afterJson?: object;
  reasonCode?: string;
  notes?: string;
}

// Canonical audit action constants
export const AUDIT_ACTIONS = {
  QUEUE_OVERRIDE_APPLIED: 'QUEUE_OVERRIDE_APPLIED',
  QUEUE_OVERRIDE_CLEARED: 'QUEUE_OVERRIDE_CLEARED',
  QUEUE_OVERRIDE_EXPIRED: 'QUEUE_OVERRIDE_EXPIRED',
  CONFIG_CHANGE: 'CONFIG_CHANGE',
  ROLE_CHANGE: 'ROLE_CHANGE',
  APPOINTMENT_CANCEL: 'APPOINTMENT_CANCEL',
  APPOINTMENT_MISSED: 'APPOINTMENT_MISSED',
  MANUAL_STATUS_CHANGE: 'MANUAL_STATUS_CHANGE',
  PRIOR_SERVICE_ENTRY: 'PRIOR_SERVICE_ENTRY',
  MILEAGE_GATE_OVERRIDE: 'MILEAGE_GATE_OVERRIDE',
  MOBILE_JACK_OVERRIDE: 'MOBILE_JACK_OVERRIDE',
  SAME_DAY_CUTOFF_OVERRIDE: 'SAME_DAY_CUTOFF_OVERRIDE',
  VEHICLE_CLASSIFIED: 'VEHICLE_CLASSIFIED', // CR-2026-008
  SERVICE_VISIT_ABANDONED: 'SERVICE_VISIT_ABANDONED', // CR-2026-018 (P3) — no-show / left before service
  CUSTOMER_NOTIFICATION_OPTIN: 'CUSTOMER_NOTIFICATION_OPTIN', // P4(b) — consent captured at check-in
  PAYMENT_RELEASE_OVERRIDE: 'PAYMENT_RELEASE_OVERRIDE', // P4(c) — manager release exception (GOV-005)
  DEV_LOGIN: 'DEV_LOGIN', // CR-2026-022 — dev-only one-click role login (gated)
  DEV_SANDBOX_CLEANED_UP: 'DEV_SANDBOX_CLEANED_UP', // CR-2026-023 — dev-login sandbox session cleanup
  SCHEDULE_HOLD_CREATED: 'SCHEDULE_HOLD_CREATED', // CR-2026-026 — advisory schedule hold
  SCHEDULE_HOLD_RELEASED: 'SCHEDULE_HOLD_RELEASED', // CR-2026-026
  SCHEDULE_HOLD_CONVERTED: 'SCHEDULE_HOLD_CONVERTED', // CR-2026-026 — hold → appointment
  COMPLAINT_CREATED: 'COMPLAINT_CREATED', // CR-2026-032 — customer complaints
  COMPLAINT_ACKNOWLEDGED: 'COMPLAINT_ACKNOWLEDGED', // CR-2026-032
  COMPLAINT_RESOLVED: 'COMPLAINT_RESOLVED', // CR-2026-032
  COMPLAINT_UPDATED: 'COMPLAINT_UPDATED', // CR-2026-032
  INSPECTION_CREATED: 'INSPECTION_CREATED', // CR-2026-034
  INSPECTION_COMPLETED: 'INSPECTION_COMPLETED', // CR-2026-034
  INSPECTION_CANCELLED: 'INSPECTION_CANCELLED', // CR-2026-034
  INSPECTION_SIGNED_OFF: 'INSPECTION_SIGNED_OFF', // CR-2026-034 C-3
  INSPECTION_CUSTOMER_SIGNED: 'INSPECTION_CUSTOMER_SIGNED', // CR-2026-034 C-3
  INSPECTION_RECOMMENDATION_DECISION: 'INSPECTION_RECOMMENDATION_DECISION', // CR-2026-034 C-3
  INSPECTION_REC_TO_WORK_ORDER: 'INSPECTION_REC_TO_WORK_ORDER', // CR-2026-034 C-5
} as const;

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(input: LogAuditInput) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeJson: (input.beforeJson as any) ?? undefined,
        afterJson: (input.afterJson as any) ?? undefined,
        reasonCode: input.reasonCode,
        notes: input.notes,
      },
    });
  }

  async search(filters: {
    actorId?: string;
    entityType?: string;
    action?: string;
    from?: Date;
    to?: Date;
    skip?: number;
    take?: number;
  }) {
    const where: Record<string, unknown> = {};

    if (filters.actorId) where.actorUserId = filters.actorId;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.action) where.action = filters.action;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filters.skip ?? 0,
        take: filters.take ?? 50,
        include: {
          actor: { select: { fullName: true, roleCode: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total };
  }
}
