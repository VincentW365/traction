import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { VisitNoteKind } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { operationalVisitWhere } from '../../common/helpers/operational-scope';

/**
 * CR-2026-101 — typed operational notes on a visit.
 *
 * The customer's stated concern, an advisor's context, a manager's instruction
 * and a technician's finding are different facts and stay distinguishable —
 * author, role and timestamp on every row, never one anonymous notes blob.
 *
 * Role separation is enforced HERE, not in the UI: a technician can record
 * findings (TECHNICIAN), flag danger (SAFETY) and report incorrect master data
 * (DATA_REPORT — the deliberate alternative to editing customer/vehicle
 * records they must not touch), but cannot put words in the customer's or the
 * manager's mouth. SAFETY and DATA_REPORT always require advisor/manager
 * attention; resolution is recorded on the row, never by deletion.
 */

const KIND_BY_ROLE: Record<string, VisitNoteKind[]> = {
  TECHNICIAN: ['TECHNICIAN', 'SAFETY', 'DATA_REPORT'],
  SERVICE_ADVISOR: ['CUSTOMER_CONCERN', 'ADVISOR', 'SAFETY', 'DATA_REPORT'],
  // The MANAGER kind is a management instruction — only a manager writes one.
  ADMIN: ['CUSTOMER_CONCERN', 'ADVISOR', 'MANAGER', 'TECHNICIAN', 'SAFETY', 'DATA_REPORT'],
};

const ALWAYS_ATTENTION: VisitNoteKind[] = ['SAFETY', 'DATA_REPORT'];

export interface CreateVisitNoteInput {
  kind: VisitNoteKind;
  text: string;
  serviceOrderId?: string;
  requestAttention?: boolean;
}

@Injectable()
export class VisitNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async addNote(
    serviceVisitId: string,
    input: CreateVisitNoteInput,
    user: { sub: string; role: string },
  ) {
    if (!input.text?.trim()) {
      throw new BadRequestException('A note needs text.');
    }
    const allowed = KIND_BY_ROLE[user.role] ?? [];
    if (!allowed.includes(input.kind)) {
      throw new ForbiddenException(
        `Your role cannot record a ${input.kind} note.`,
      );
    }
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      select: { id: true },
    });
    if (!visit) throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    if (input.serviceOrderId) {
      const order = await this.prisma.serviceOrder.findFirst({
        where: { id: input.serviceOrderId, serviceVisitId },
        select: { id: true },
      });
      if (!order) {
        throw new BadRequestException('serviceOrderId does not belong to this visit.');
      }
    }

    const requiresAttention =
      ALWAYS_ATTENTION.includes(input.kind) || input.requestAttention === true;

    const note = await this.prisma.visitNote.create({
      data: {
        serviceVisitId,
        serviceOrderId: input.serviceOrderId ?? null,
        kind: input.kind,
        text: input.text.trim(),
        authorUserId: user.sub,
        authorRole: user.role,
        requiresAttention,
      },
    });

    // A safety flag or a master-data report is an operational event, not just
    // a note — audited so "who raised it and when" survives any later UI.
    if (ALWAYS_ATTENTION.includes(input.kind)) {
      await this.audit.log({
        actorUserId: user.sub,
        action: input.kind === 'SAFETY' ? 'SAFETY_CONCERN_RAISED' : 'DATA_CORRECTION_REPORTED',
        entityType: 'VisitNote',
        entityId: note.id,
        afterJson: { serviceVisitId, serviceOrderId: input.serviceOrderId ?? null },
        notes: input.text.trim(),
      });
    }

    return note;
  }

  /** All notes on a visit, oldest first, with author names resolved. */
  async listForVisit(serviceVisitId: string) {
    const notes = await this.prisma.visitNote.findMany({
      where: { serviceVisitId },
      orderBy: { createdAt: 'asc' },
    });
    const userIds = [
      ...new Set(notes.flatMap((n) => [n.authorUserId, n.resolvedByUserId]).filter(Boolean)),
    ] as string[];
    const users = userIds.length
      ? await this.prisma.userAccount.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));
    return notes.map((n) => ({
      id: n.id,
      serviceOrderId: n.serviceOrderId,
      kind: n.kind,
      text: n.text,
      authorName: nameById.get(n.authorUserId) ?? null,
      authorRole: n.authorRole,
      requiresAttention: n.requiresAttention,
      resolvedAt: n.resolvedAt,
      resolvedByName: n.resolvedByUserId ? (nameById.get(n.resolvedByUserId) ?? null) : null,
      resolutionNotes: n.resolutionNotes,
      createdAt: n.createdAt,
    }));
  }

  /**
   * Open attention items (safety flags, data reports, explicit requests) for
   * the advisor/manager — never buried in an audit log.
   */
  async listAttention(siteId?: string) {
    const notes = await this.prisma.visitNote.findMany({
      where: {
        requiresAttention: true,
        resolvedAt: null,
        serviceVisit: { ...(siteId ? { siteId } : {}), ...operationalVisitWhere() },
      },
      include: {
        serviceVisit: {
          select: {
            id: true,
            visitNumber: true,
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
            queueTicket: { select: { id: true, ticketNumber: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const userIds = [...new Set(notes.map((n) => n.authorUserId))];
    const users = userIds.length
      ? await this.prisma.userAccount.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));
    const now = Date.now();
    return notes.map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      authorName: nameById.get(n.authorUserId) ?? null,
      authorRole: n.authorRole,
      createdAt: n.createdAt,
      waitingMinutes: Math.floor((now - n.createdAt.getTime()) / 60000),
      serviceVisitId: n.serviceVisit.id,
      visitNumber: n.serviceVisit.visitNumber ?? null,
      queueTicketId: n.serviceVisit.queueTicket?.id ?? null,
      ticketNumber: n.serviceVisit.queueTicket?.ticketNumber ?? null,
      customerName: `${n.serviceVisit.customer.firstName} ${n.serviceVisit.customer.lastName}`,
      vehiclePlate: n.serviceVisit.vehicle.plateNumber,
    }));
  }

  /** Advisor/manager marks an attention item handled — recorded, never deleted. */
  async resolve(noteId: string, resolutionNotes: string | undefined, userId: string) {
    const note = await this.prisma.visitNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException(`VisitNote ${noteId} not found`);
    if (!note.requiresAttention) {
      throw new BadRequestException('This note does not require attention.');
    }
    if (note.resolvedAt) {
      throw new BadRequestException('This item has already been resolved.');
    }

    const updated = await this.prisma.visitNote.update({
      where: { id: noteId },
      data: {
        resolvedByUserId: userId,
        resolvedAt: new Date(),
        resolutionNotes: resolutionNotes?.trim() || null,
      },
    });

    await this.audit.log({
      actorUserId: userId,
      action: 'VISIT_NOTE_RESOLVED',
      entityType: 'VisitNote',
      entityId: noteId,
      beforeJson: { kind: note.kind, text: note.text },
      afterJson: { resolutionNotes: resolutionNotes?.trim() || null },
    });

    return updated;
  }
}
