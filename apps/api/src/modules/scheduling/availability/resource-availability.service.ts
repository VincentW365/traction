/**
 * CR-2026-108 Stage 5C — feeding the resource-aware solver from the database.
 *
 * The pure engine (`resource-capacity.engine.ts`) knows nothing about Prisma. This
 * service is the boundary: it loads the shop's physical configuration and the jobs
 * already on the book, hands both to the solver, and hands back a decision.
 *
 * ONE LOAD PER EVALUATION. A slot grid runs the solver dozens of times over the
 * same configuration, and re-reading resources per slot would turn a page load
 * into a hundred queries while introducing the very inconsistency the fingerprint
 * exists to detect. So the caller builds a `ResourceSnapshot` once and reuses it.
 *
 * SHADOW SAFETY. Nothing here writes, and nothing here is consulted by the
 * production availability path while `booking_capacity_mode` is FIXED. The
 * resource engine's opinion is recorded and compared; it never decides.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  evaluateResourceCapacity,
  isCountablePosition,
  type CapacityJob,
  type ResourceCapacityDecision,
  type ResourcePosition,
} from './resource-capacity.engine';
import { ACTIVE_APPOINTMENT_STATUSES } from './booking-availability.service';

/** Everything the solver needs about the shop, read once. */
export interface ResourceSnapshot {
  siteId: string;
  resources: ResourcePosition[];
  /** Unclassified, non-external, live resources — makes every count a lower bound. */
  unverifiedResourceCount: number;
  /** Jobs already on the book in the window, with the capability each needs. */
  jobs: CapacityJob[];
  /**
   * Digest of the configuration that produced this snapshot. A shadow finding
   * from last week is uninterpretable the moment somebody commissions a bay, so
   * every recorded comparison is tied to the inventory it was measured against.
   */
  fingerprint: string;
  /** Capability totals for the dashboard. NEVER summed into a shop total. */
  capabilityPositions: Record<string, number>;
  /** Confirmed, usable vehicle positions right now. */
  activePositions: number;
}

const MS = 60_000;
const DAY_MS = 24 * 60 * MS;

@Injectable()
export class ResourceAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the shop once: its positions, what each can do, and what is booked.
   *
   * `defaultDurationMinutes` fills in an appointment with no recorded end — the
   * same assumption the fixed engine makes, so a difference between the two models
   * is never an artefact of one of them guessing differently.
   */
  async snapshot(
    siteId: string,
    window: { from: Date; to: Date },
    opts: { defaultDurationMinutes: number; excludeAppointmentId?: string | null } = { defaultDurationMinutes: 80 },
  ): Promise<ResourceSnapshot> {
    const [rows, appointments] = await Promise.all([
      this.prisma.workResource.findMany({
        where: { siteId },
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        select: {
          id: true, code: true, capacityRole: true, capacity: true, isActive: true,
          retiredAt: true, schedulingEnabled: true, supportsSedan: true, supportsSuv: true,
          liftType: true, resourceCategory: true,
          operationalStatus: { select: { status: true } },
          serviceCapabilities: { select: { capability: true }, orderBy: { capability: 'asc' } },
        },
      }),
      this.prisma.appointment.findMany({
        where: {
          siteId,
          status: { in: [...ACTIVE_APPOINTMENT_STATUSES] as never[] },
          scheduledStartAt: { gte: new Date(window.from.getTime() - DAY_MS), lte: new Date(window.to.getTime() + DAY_MS) },
          ...(opts.excludeAppointmentId ? { id: { not: opts.excludeAppointmentId } } : {}),
        },
        select: {
          id: true,
          scheduledStartAt: true,
          scheduledEndAt: true,
          vehicle: { select: { serviceClass: true } },
          services: { select: { serviceType: { select: { requiredBayType: true } } } },
        },
      }),
    ]);

    const resources: ResourcePosition[] = rows.map((r) => ({
      id: r.id,
      code: r.code,
      capacityRole: String(r.capacityRole),
      capabilities: r.serviceCapabilities.map((c) => c.capability),
      capacity: r.capacity,
      isActive: r.isActive,
      retired: r.retiredAt != null,
      schedulingEnabled: r.schedulingEnabled,
      // Absence of a status row means AVAILABLE — `setStatus` upserts on change.
      operationalStatus: r.operationalStatus?.status ? String(r.operationalStatus.status) : 'AVAILABLE',
      supportsSedan: r.supportsSedan,
      supportsSuv: r.supportsSuv,
      liftType: r.liftType,
    }));

    const jobs: CapacityJob[] = appointments.map((a) => ({
      id: a.id,
      startAt: a.scheduledStartAt,
      endAt: a.scheduledEndAt ?? new Date(a.scheduledStartAt.getTime() + opts.defaultDurationMinutes * MS),
      requiredCapability: primaryCapability(a.services.map((s) => s.serviceType.requiredBayType)),
      vehicleClass: a.vehicle?.serviceClass ? String(a.vehicle.serviceClass) : null,
    }));

    const unverifiedResourceCount = rows.filter(
      (r) => String(r.capacityRole) === 'UNVERIFIED' && !r.retiredAt && r.isActive && String(r.resourceCategory) !== 'EXTERNAL',
    ).length;

    const countable = resources.filter(isCountablePosition);
    const capabilityPositions: Record<string, number> = {};
    for (const r of countable) {
      for (const c of r.capabilities) capabilityPositions[c] = (capabilityPositions[c] ?? 0) + r.capacity;
    }

    return {
      siteId,
      resources,
      unverifiedResourceCount,
      jobs,
      fingerprint: fingerprintOf(resources),
      capabilityPositions,
      activePositions: countable.reduce((n, r) => n + r.capacity, 0),
    };
  }

  /** Run the solver for one candidate interval against a snapshot. */
  evaluate(
    snapshot: ResourceSnapshot,
    candidate: { startAt: Date; endAt: Date; requiredCapability: string | null; vehicleClass: string | null },
    excludeJobId?: string | null,
  ): ResourceCapacityDecision {
    return evaluateResourceCapacity({
      resources: snapshot.resources,
      existing: excludeJobId ? snapshot.jobs.filter((j) => j.id !== excludeJobId) : snapshot.jobs,
      candidate: { id: '__candidate__', ...candidate },
      unverifiedResourceCount: snapshot.unverifiedResourceCount,
    });
  }
}

/**
 * Which capability does a multi-service appointment need?
 *
 * The specialist one. A booking for an oil change AND a wheel alignment needs an
 * alignment bay for part of it, so the scarcer requirement is what constrains
 * where the vehicle can go. GENERAL is the fallback because it is what every
 * heavy lift can do, so requiring it constrains nothing extra.
 *
 * This is an acknowledged simplification: a two-service job may really need two
 * different bays in sequence. Modelling that is a scheduling problem, not a
 * capacity one, and pretending otherwise here would produce confident numbers
 * about something nobody has measured.
 */
export function primaryCapability(required: Array<string | null>): string | null {
  const present = required.filter((c): c is string => !!c);
  if (present.length === 0) return null;
  const specialist = present.find((c) => c !== 'GENERAL');
  return specialist ?? present[0];
}

/**
 * A stable digest of what the solver was looking at.
 *
 * Covers exactly the fields that change an eligibility decision. Ordering is
 * normalised so a reordered query does not read as a configuration change.
 */
export function fingerprintOf(resources: ResourcePosition[]): string {
  const parts = resources
    .map((r) =>
      [
        r.code,
        r.capacityRole,
        r.capacity,
        r.isActive ? 1 : 0,
        r.retired ? 1 : 0,
        r.schedulingEnabled ? 1 : 0,
        r.operationalStatus,
        r.supportsSedan ? 1 : 0,
        r.supportsSuv ? 1 : 0,
        r.liftType ?? '-',
        [...r.capabilities].sort().join('+') || '-',
      ].join(':'),
    )
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
