import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  computeLabourMeasures,
  type LabourMeasures,
} from './engine/labour-measures';

/**
 * CR-2026-090 — per-technician work segments.
 *
 * Why this exists. CR-2026-088 could not answer "how long did Marcus spend on this
 * job?" for any job more than one person touched, and said so rather than guessing.
 * The reason was structural: there is one assignment row per technician with a single
 * start and end, and the pause ledger is per ORDER. When two technicians overlap,
 * nothing in that data says who was working when, so any per-technician split would
 * have been an invention presented as a measurement.
 *
 * A segment records it directly: one row per continuous period a named technician was
 * working on a named order. Pausing closes segments; resuming opens fresh ones. The
 * sum of a technician's segments IS their labour on the job, with nothing inferred.
 *
 * Deliberate boundaries:
 *
 *  - Segments do NOT change how a job is rated. `calculateKpi` still measures job
 *    wall-clock from first Start Work to first Submit to QC against the benchmark.
 *    Segments add labour measures ALONGSIDE that; they do not become a new way to
 *    score an individual on a shared job. The CR is explicit that no attribution
 *    formula may be invented, and none is.
 *
 *  - Segments hang off the existing `TechnicianAssignment` rather than creating a
 *    competing notion of who is on a job.
 *
 *  - Every write states its cause (`startSource` / `endReason`), because a segment
 *    the system closed during cleanup and one a technician ended by submitting to QC
 *    are different facts, and a labour report that cannot tell them apart will
 *    eventually be used to argue about someone's pay.
 */

/** Prisma client or an interactive transaction client — segments join callers' transactions. */
type Db = Pick<PrismaService, 'technicianWorkSegment' | 'technicianAssignment'>;

export type SegmentRole = 'PRIMARY' | 'ASSISTING' | 'REPLACEMENT';

export type SegmentStartSource =
  | 'TECHNICIAN_START'
  | 'TECHNICIAN_RESUME'
  | 'ASSISTANCE_START'
  | 'REASSIGNMENT'
  | 'MANAGER_CORRECTION';

export type SegmentEndReason =
  | 'PAUSED'
  | 'REASSIGNED'
  | 'ASSISTANCE_COMPLETE'
  | 'SUBMITTED_TO_QC'
  | 'JOB_CANCELLED'
  | 'SYSTEM_CLOSED'
  | 'CORRECTED_BY_MANAGER'
  // CR-2026-100 — the technician moved to another job while colleagues kept
  // working this one: only their segment closes, the order stays IN_PROGRESS.
  | 'SWITCHED_JOB';

export interface StartSegmentInput {
  serviceOrderId: string;
  assignmentId: string;
  technicianId: string;
  role?: SegmentRole;
  startSource?: SegmentStartSource;
  actorUserId: string | null;
  at?: Date;
  notes?: string;
}

@Injectable()
export class WorkSegmentService {
  private readonly logger = new Logger(WorkSegmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open a segment for a technician on a job.
   *
   * Idempotent by design: if this technician already has an open segment on this
   * order, the existing one is returned untouched. A double-tapped Start button, a
   * retried request or a client that fires on reconnect must not fragment one
   * continuous period of work into two rows — and must never create the second open
   * segment that would make "when did they start?" ambiguous. The database enforces
   * the same rule with a partial unique index, so a race loses rather than corrupts.
   */
  async startSegment(input: StartSegmentInput, db: Db = this.prisma) {
    const at = input.at ?? new Date();

    const open = await db.technicianWorkSegment.findFirst({
      where: {
        serviceOrderId: input.serviceOrderId,
        technicianId: input.technicianId,
        endedAt: null,
      },
    });
    if (open) return open;

    const created = await db.technicianWorkSegment.create({
      data: {
        serviceOrderId: input.serviceOrderId,
        assignmentId: input.assignmentId,
        technicianId: input.technicianId,
        roleSnapshot: (input.role ?? 'PRIMARY') as never,
        startSource: (input.startSource ?? 'TECHNICIAN_START') as never,
        startedAt: at,
        startedByUserId: input.actorUserId,
        notes: input.notes,
      },
    });

    this.logger.log(
      `Work segment opened: order ${input.serviceOrderId}, technician ${input.technicianId}, ` +
        `${input.startSource ?? 'TECHNICIAN_START'}`,
    );
    return created;
  }

  /**
   * Close a technician's open segment on a job.
   *
   * Returns null when there is nothing open. That is a normal outcome, not an error:
   * a technician who submits to QC after the job was already paused has no open
   * segment, and refusing their submission over a bookkeeping detail would block real
   * work for no benefit.
   */
  async endSegment(
    params: {
      serviceOrderId: string;
      technicianId: string;
      endReason: SegmentEndReason;
      actorUserId: string | null;
      at?: Date;
    },
    db: Db = this.prisma,
  ) {
    const at = params.at ?? new Date();

    const open = await db.technicianWorkSegment.findFirst({
      where: {
        serviceOrderId: params.serviceOrderId,
        technicianId: params.technicianId,
        endedAt: null,
      },
    });
    if (!open) return null;

    // Clock skew or a corrected start can put "now" before the segment start. Ending
    // at the start yields a zero-length segment, which is honest; a negative one
    // would be a labour credit for time never worked, and the CHECK constraint
    // refuses it anyway.
    const endedAt = at < open.startedAt ? open.startedAt : at;

    return db.technicianWorkSegment.update({
      where: { id: open.id },
      data: {
        endedAt,
        endReason: params.endReason as never,
        endedByUserId: params.actorUserId,
      },
    });
  }

  /**
   * Close every open segment on a job.
   *
   * Used wherever work stops for the whole order rather than for one person: pause,
   * submit to QC, cancellation.
   */
  async endAllForOrder(
    params: {
      serviceOrderId: string;
      endReason: SegmentEndReason;
      actorUserId: string | null;
      at?: Date;
    },
    db: Db = this.prisma,
  ): Promise<number> {
    const at = params.at ?? new Date();

    const open = await db.technicianWorkSegment.findMany({
      where: { serviceOrderId: params.serviceOrderId, endedAt: null },
      select: { id: true, startedAt: true },
    });
    if (open.length === 0) return 0;

    // Updated individually rather than with one updateMany, because each segment's
    // end has to be clamped to its own start.
    for (const s of open) {
      await db.technicianWorkSegment.update({
        where: { id: s.id },
        data: {
          endedAt: at < s.startedAt ? s.startedAt : at,
          endReason: params.endReason as never,
          endedByUserId: params.actorUserId,
        },
      });
    }

    this.logger.log(
      `Closed ${open.length} work segment(s) on order ${params.serviceOrderId} (${params.endReason})`,
    );
    return open.length;
  }

  /**
   * Reopen segments for everyone still assigned after a pause ends.
   *
   * Only assignments that are genuinely still active are reopened. A technician who
   * was removed from the job while it sat paused must not silently start accruing
   * labour again when someone else resumes it.
   *
   * CR-2026-101 — and a technician currently ON THE CLOCK for another job is
   * skipped too: resuming a held job must never open a second simultaneous
   * labour segment for the same person (the same physics rule the start guard
   * enforces). They come back to this job through the explicit switch.
   */
  async resumeForOrder(
    params: { serviceOrderId: string; actorUserId: string | null; at?: Date },
    db: Db = this.prisma,
  ): Promise<number> {
    const at = params.at ?? new Date();

    const active = await db.technicianAssignment.findMany({
      where: { serviceOrderId: params.serviceOrderId, endedAt: null },
      select: { id: true, technicianId: true, isPrimary: true },
    });

    let opened = 0;
    for (const a of active) {
      const busyElsewhere = await db.technicianWorkSegment.findFirst({
        where: {
          technicianId: a.technicianId,
          endedAt: null,
          serviceOrderId: { not: params.serviceOrderId },
        },
        select: { id: true },
      });
      if (busyElsewhere) {
        this.logger.log(
          `resumeForOrder: technician ${a.technicianId} is on the clock elsewhere — ` +
            `segment on ${params.serviceOrderId} not reopened`,
        );
        continue;
      }
      const seg = await this.startSegment(
        {
          serviceOrderId: params.serviceOrderId,
          assignmentId: a.id,
          technicianId: a.technicianId,
          role: a.isPrimary ? 'PRIMARY' : 'ASSISTING',
          startSource: 'TECHNICIAN_RESUME',
          actorUserId: params.actorUserId,
          at,
        },
        db,
      );
      if (seg) opened++;
    }
    return opened;
  }

  /**
   * Hand a job from one technician to another.
   *
   * The outgoing technician's segment closes as REASSIGNED and the incoming one opens
   * as REPLACEMENT, in a single transaction. Both halves must land together: a
   * half-applied reassignment leaves either two people accruing labour at once, or
   * nobody accruing it at all, and both are wrong in ways that only show up in a
   * report weeks later.
   */
  async reassign(params: {
    serviceOrderId: string;
    fromTechnicianId: string;
    toTechnicianId: string;
    toAssignmentId: string;
    actorUserId: string | null;
    at?: Date;
  }) {
    const at = params.at ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const closed = await this.endSegment(
        {
          serviceOrderId: params.serviceOrderId,
          technicianId: params.fromTechnicianId,
          endReason: 'REASSIGNED',
          actorUserId: params.actorUserId,
          at,
        },
        tx as unknown as Db,
      );

      const opened = await this.startSegment(
        {
          serviceOrderId: params.serviceOrderId,
          assignmentId: params.toAssignmentId,
          technicianId: params.toTechnicianId,
          role: 'REPLACEMENT',
          startSource: 'REASSIGNMENT',
          actorUserId: params.actorUserId,
          at,
        },
        tx as unknown as Db,
      );

      return { closed, opened };
    });
  }

  // -------------------------------------------------------------------------
  // Manager correction
  // -------------------------------------------------------------------------

  /**
   * Correct a segment's times after the fact.
   *
   * Segments are captured from live actions, so they inherit every way a live action
   * goes wrong: a technician who forgot to press Start, a tablet that lost signal, a
   * segment the system closed at end of day. Those need fixing, or the labour report
   * gets quietly disbelieved and then ignored.
   *
   * A correction always carries a reason and an actor, and is audited with the before
   * and after values. An editable labour record with no trail is not a labour record.
   */
  async correctSegment(
    segmentId: string,
    changes: { startedAt?: Date; endedAt?: Date | null; reason: string },
    actorUserId: string,
  ) {
    if (!changes.reason?.trim()) {
      throw new BadRequestException('A correction must state a reason.');
    }

    const existing = await this.prisma.technicianWorkSegment.findUnique({
      where: { id: segmentId },
    });
    if (!existing) throw new NotFoundException(`Work segment ${segmentId} not found`);

    const startedAt = changes.startedAt ?? existing.startedAt;
    const endedAt =
      changes.endedAt === undefined ? existing.endedAt : changes.endedAt;

    if (endedAt && endedAt < startedAt) {
      throw new BadRequestException('A segment cannot end before it starts.');
    }

    // Reopening a segment while another is already open for the same technician would
    // breach the one-open-segment rule. The database would reject it; catching it here
    // gives the manager a sentence they can act on instead of a constraint violation.
    if (!endedAt) {
      const otherOpen = await this.prisma.technicianWorkSegment.findFirst({
        where: {
          serviceOrderId: existing.serviceOrderId,
          technicianId: existing.technicianId,
          endedAt: null,
          id: { not: segmentId },
        },
      });
      if (otherOpen) {
        throw new BadRequestException(
          'This technician already has an open segment on this job. Close that one before reopening this.',
        );
      }
    }

    const updated = await this.prisma.technicianWorkSegment.update({
      where: { id: segmentId },
      data: {
        startedAt,
        endedAt,
        correctedByUserId: actorUserId,
        correctedAt: new Date(),
        correctionReason: changes.reason.trim(),
        endReason: endedAt ? ('CORRECTED_BY_MANAGER' as never) : null,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'KPI_WORK_SEGMENT_CORRECTED',
      entityType: 'TechnicianWorkSegment',
      entityId: segmentId,
      beforeJson: {
        startedAt: existing.startedAt,
        endedAt: existing.endedAt,
      },
      afterJson: { startedAt, endedAt },
      notes: changes.reason.trim(),
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async listForOrder(serviceOrderId: string) {
    return this.prisma.technicianWorkSegment.findMany({
      where: { serviceOrderId },
      orderBy: { startedAt: 'asc' },
    });
  }

  /**
   * Labour measures for one job.
   *
   * Exclusions come from the KPI delay ledger, not the pause ledger — a pause is a
   * fact, an exclusion is an approved decision, and only the latter may reduce a
   * reported figure.
   */
  async getLabourForOrder(
    serviceOrderId: string,
    now: Date = new Date(),
  ): Promise<LabourMeasures> {
    const [segments, exclusions] = await Promise.all([
      this.prisma.technicianWorkSegment.findMany({
        where: { serviceOrderId },
        select: { technicianId: true, startedAt: true, endedAt: true },
      }),
      this.prisma.kpiDelayEvent.findMany({
        where: {
          serviceOrderId,
          requestedForExclusion: true,
          approvalStatus: 'APPROVED',
        },
        select: { startedAt: true, endedAt: true },
      }),
    ]);

    return computeLabourMeasures(segments, exclusions, now);
  }
}
