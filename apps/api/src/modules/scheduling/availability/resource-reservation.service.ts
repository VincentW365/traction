/**
 * CR-2026-108 Stage 5C §17/§18 — capacity reservations.
 *
 * WHAT A RESERVATION IS
 *
 * "One compatible ALIGNMENT position, 09:00–10:00" — not "ALIGN-01". A customer
 * picking a time three weeks out must not be handed a dispatch decision: the bay
 * that is free on the day is not knowable now, and pinning one would break the
 * moment it went into maintenance. `resourceId` stays null and
 * `requiredCapability` says what it has to be compatible with; dispatch chooses
 * the physical position when the vehicle actually arrives.
 *
 * The exception, deliberately narrow: a service that genuinely requires one
 * specific resource may name it. Nothing in the catalogue does today, and the
 * signature allows it rather than the code assuming it.
 *
 * WHY THIS EXISTS BEFORE IT IS USED
 *
 * Under FIXED — which is production — this writes nothing. The race it guards
 * against is real but only reachable once RESOURCE_AWARE decides what customers
 * are offered, and by then the architecture has to already be right. Building it
 * now means the concurrency design is reviewed and tested while the stakes are a
 * test database rather than a Saturday morning.
 *
 * THE RACE
 *
 *   availability says yes → [another booking lands] → appointment created
 *
 * Two customers can be told the last alignment slot is free, and both can take it.
 * The guard is the SAME per-site-per-day advisory lock every other writer already
 * takes (`BookingAvailabilityService.lockDay`): re-check and reserve inside that
 * lock and the second writer serialises behind the first, sees the reservation,
 * and loses cleanly with a message rather than silently double-booking a bay.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { CapacityJob } from './resource-capacity.engine';

/** Reservation states that still hold capacity. */
export const HOLDING_STATUSES = ['PENDING', 'ACTIVE'] as const;

export interface ReserveInput {
  siteId: string;
  appointmentId: string;
  serviceVisitId?: string | null;
  /** What the position has to be able to do. Null = any position. */
  requiredCapability: string | null;
  reservedFrom: Date;
  reservedUntil: Date;
  /** Only for a service that genuinely requires one specific resource. */
  resourceId?: string | null;
}

@Injectable()
export class ResourceReservationService {
  private readonly logger = new Logger('ResourceReservation');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hold one compatible position for an appointment.
   *
   * Must be called inside the transaction that creates the appointment, after
   * `lockDay`. Outside that lock it is not a guarantee, only a record.
   */
  async reserve(tx: Prisma.TransactionClient, input: ReserveInput) {
    return tx.resourceReservation.create({
      data: {
        siteId: input.siteId,
        // Abstract by default. See the note at the top of this file.
        resourceId: input.resourceId ?? null,
        requiredCapability: input.requiredCapability,
        appointmentId: input.appointmentId,
        serviceVisitId: input.serviceVisitId ?? null,
        reservedFrom: input.reservedFrom,
        reservedUntil: input.reservedUntil,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Release whatever an appointment was holding.
   *
   * Cancellation and reschedule both come through here. Rows are marked
   * CANCELLED rather than deleted: a released reservation is part of how the
   * capacity was used that day, and deleting it would erase the explanation for
   * why a slot was unavailable at 10am and free at 10:05.
   */
  async release(tx: Prisma.TransactionClient, appointmentId: string, reason: 'CANCELLED' | 'RESCHEDULED' | 'EXPIRED' = 'CANCELLED') {
    const { count } = await tx.resourceReservation.updateMany({
      where: { appointmentId, status: { in: [...HOLDING_STATUSES] } },
      data: {
        status: reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED',
        expiredAt: new Date(),
      },
    });
    return { released: count };
  }

  /**
   * Move a reservation to a new interval, atomically.
   *
   * Release-then-reserve in ONE transaction, never two. Split across two and the
   * old interval is free for an instant — which is exactly long enough for a
   * concurrent booking to take the position this appointment is about to need,
   * leaving a customer who merely moved their time with no bay at all.
   */
  async moveTo(tx: Prisma.TransactionClient, appointmentId: string, next: Omit<ReserveInput, 'appointmentId'>) {
    await this.release(tx, appointmentId, 'RESCHEDULED');
    return this.reserve(tx, { ...next, appointmentId });
  }

  /**
   * Reservations that overlap a window, as jobs the solver can reason about.
   *
   * Once RESOURCE_AWARE is production-active this is what closes the gap between
   * "an appointment exists" and "capacity is spoken for": a reservation made
   * seconds ago by a transaction that has not finished creating its appointment
   * is already visible here.
   */
  async holdsAsJobs(
    client: Pick<Prisma.TransactionClient, 'resourceReservation'> | PrismaService,
    siteId: string,
    window: { from: Date; to: Date },
    excludeAppointmentId: string | null = null,
  ): Promise<CapacityJob[]> {
    const rows = await client.resourceReservation.findMany({
      where: {
        siteId,
        status: { in: [...HOLDING_STATUSES] },
        reservedFrom: { lt: window.to },
        reservedUntil: { gt: window.from },
        ...(excludeAppointmentId ? { appointmentId: { not: excludeAppointmentId } } : {}),
      },
      select: { id: true, appointmentId: true, reservedFrom: true, reservedUntil: true, requiredCapability: true, resourceId: true },
    });
    return rows.map((r) => ({
      id: `reservation:${r.id}`,
      startAt: r.reservedFrom,
      endAt: r.reservedUntil,
      requiredCapability: r.requiredCapability,
      // A reservation is capacity, not a vehicle: there is no class to restrict on.
      vehicleClass: null,
    }));
  }

  /**
   * Reservations whose appointment has gone away. Housekeeping, not a guard.
   *
   * A reservation is always released by the path that cancels or reschedules; this
   * is the net beneath a crash between the two writes.
   */
  async expireOrphaned(now = new Date()): Promise<{ expired: number }> {
    const { count } = await this.prisma.resourceReservation.updateMany({
      where: {
        status: { in: [...HOLDING_STATUSES] },
        reservedUntil: { lt: now },
      },
      data: { status: 'EXPIRED', expiredAt: now },
    });
    if (count > 0) this.logger.log(`Expired ${count} reservation(s) whose interval has passed`);
    return { expired: count };
  }
}
