/**
 * CR-2026-121 — the workshop as management confirmed it, applied on every deploy.
 *
 * Before this file the eight numbered positions existed only on one developer's
 * machine. A fresh deployment got a shop with no lifts and a screen asking a
 * manager to "walk the shop". The walk has been done — the photographic audit of
 * CR-2026-119 (2026-10-15) — and the questions it left open were answered by
 * management on 2026-10-16:
 *
 *   - positions 1, 2, 4 and 8 are two-post lifts; 3 and 6 are drive-on runway
 *     lifts; 5 and 7 are ground-level positions with no lift;
 *   - any lift takes any kind of work: there is no dedicated lube, diagnostic or
 *     inspection position, and there is NO wheel-alignment equipment;
 *   - positions 5 and 7 are real work positions for general ground-level work.
 *     They are recorded on the two OVERFLOW rows the seed already ships; the two
 *     LIGHT_SLOT rows described the same two places and are retired as duplicates;
 *   - "Mobile Lift", "Power Jack", the stands and the mobile jacks are equipment
 *     used at a position, never a position;
 *   - the wash area is a vehicle position for cleaning only; the press is
 *     equipment;
 *   - the six legacy WorkBay rows are lanes typed by kind of work, not distinct
 *     places. They stay ACTIVE — technician assignment keeps writing to them and
 *     their history is untouched — and are recorded as REPLACED by the
 *     position-keyed resources.
 *
 * Idempotent and deferential. A record is CREATED only when absent. An existing
 * record is CHANGED only while it is still in its never-classified state
 * (UNVERIFIED role, no confirmed identity, UNRESOLVED disposition): a decision a
 * manager has since made on the Resources screens is never overwritten by a
 * redeploy. Every write leaves the same audit trail the Resources screens leave,
 * so "who said this bay is a bay?" has the same answer either way — here, the
 * actor is the seeded manager account when it exists, and the note names the CR.
 *
 * Lift ratings are NOT verified: every lift is created STANDARD, the
 * conservative class, and a manager raises it on the Resources screen once the
 * plate has been read. Inventing HEAVY here would let an SUV be sent to a lift
 * nobody has checked can take it.
 */
import type { PrismaClient } from '@prisma/client';

const CR = 'CR-2026-121';
const SOURCE =
  'Photographic audit (CR-2026-119, 2026-10-15) and management answers of 2026-10-16, applied by the deployment seed (CR-2026-121).';

/**
 * What a lift can take. These are `ServiceType.requiredBayType` values, which is
 * the vocabulary capabilities are matched against. ALIGNMENT is deliberately
 * absent — there is no alignment equipment — and CLEANING belongs to the wash.
 */
export const LIFT_CAPABILITIES = ['GENERAL', 'LUBE', 'DIAGNOSTIC', 'INSPECTION', 'TIRE'] as const;
export const GROUND_CAPABILITIES = ['GENERAL'] as const;
export const WASH_CAPABILITIES = ['CLEANING'] as const;

export const LIFT_POSITIONS = [
  { code: 'LIFT-P1', position: 'Position 1', liftType: 'two_post', name: 'Two-post lift — Position 1' },
  { code: 'LIFT-P2', position: 'Position 2', liftType: 'two_post', name: 'Two-post lift — Position 2' },
  { code: 'LIFT-P3', position: 'Position 3', liftType: 'runway', name: 'Runway lift — Position 3' },
  { code: 'LIFT-P4', position: 'Position 4', liftType: 'two_post', name: 'Two-post lift — Position 4' },
  { code: 'LIFT-P6', position: 'Position 6', liftType: 'runway', name: 'Runway lift — Position 6' },
  { code: 'LIFT-P8', position: 'Position 8', liftType: 'two_post', name: 'Two-post lift — Position 8' },
] as const;

/** The two overflow rows the seed ships ARE positions 5 and 7 (management, 2026-10-16). */
export const GROUND_POSITIONS = [
  { code: 'OVF-01', position: 'Position 5', name: 'Ground-level position 5' },
  { code: 'OVF-02', position: 'Position 7', name: 'Ground-level position 7' },
] as const;

/** Described the same two ground positions under another name. */
export const DUPLICATE_SLOTS = ['LT-01', 'LT-02'] as const;

/** Equipment used at a position — never a position, never capacity. */
export const SUPPORT_EQUIPMENT = ['STAND-01', 'STAND-02', 'MJACK-01', 'MJACK-02', 'BAY-04', 'BAY-05', 'MSHOP-EXT'] as const;

export const WASH = { code: 'PWASH-01', position: 'Wash area' } as const;
export const PRESS = { code: 'PRESS-01', name: 'Bushing/Bearings Press', position: 'Press corner' } as const;

/** The six legacy WorkBay rows; lanes by kind of work, not places. */
export const LEGACY_BAY_CODES = ['BAY-01', 'BAY-02', 'BAY-03', 'BAY-04', 'BAY-05', 'BAY-06'] as const;
export const LEGACY_BAY_NOTE =
  'A lane typed by kind of work, not a distinct physical place. Replaced by the position-keyed resources ' +
  '(LIFT-P1…P8, ground positions 5 and 7). Technician assignment keeps using this row; its history is untouched. ' +
  SOURCE;

export interface WorkshopSeedSummary {
  created: string[];
  classified: string[];
  retired: string[];
  dispositioned: string[];
  skipped: string[];
  untouched: number;
}

export async function seedWorkshop(prisma: PrismaClient, siteId: string): Promise<WorkshopSeedSummary> {
  const summary: WorkshopSeedSummary = { created: [], classified: [], retired: [], dispositioned: [], skipped: [], untouched: 0 };
  const now = new Date();

  // The seeded manager account when it exists; null (= "seeded") when the users
  // have not been created yet on a brand-new database. Same convention as the
  // KPI mapping seed.
  const actor = await prisma.userAccount.findFirst({ where: { email: 'admin@bert.local' }, select: { id: true } });
  const actorUserId = actor?.id ?? null;

  const audit = (entry: {
    action: string;
    entityType: 'WorkResource' | 'WorkBay';
    entityId: string;
    beforeJson?: unknown;
    afterJson?: unknown;
    reasonCode?: string;
    notes?: string;
  }) =>
    prisma.auditLog.create({
      data: {
        actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        beforeJson: (entry.beforeJson as never) ?? undefined,
        afterJson: (entry.afterJson as never) ?? undefined,
        reasonCode: entry.reasonCode,
        notes: entry.notes ?? SOURCE,
      },
    });

  const byCode = (code: string) =>
    prisma.workResource.findUnique({
      where: { siteId_code: { siteId, code } },
      include: { serviceCapabilities: true, occupancy: true },
    });

  const setCapabilities = async (resourceId: string, code: string, capabilities: readonly string[]) => {
    await prisma.workResourceCapability.deleteMany({ where: { resourceId } });
    await prisma.workResourceCapability.createMany({ data: capabilities.map((capability) => ({ resourceId, capability })) });
    await audit({
      action: 'RESOURCE_CAPABILITIES_SET',
      entityType: 'WorkResource',
      entityId: resourceId,
      afterJson: { code, capabilities: [...capabilities] },
    });
  };

  const confirmIdentity = async (resourceId: string, code: string, name: string) => {
    await prisma.workResource.update({
      where: { id: resourceId },
      data: { identityConfirmedAt: now, identityConfirmedByUserId: actorUserId },
    });
    await audit({
      action: 'RESOURCE_IDENTITY_CONFIRMED',
      entityType: 'WorkResource',
      entityId: resourceId,
      beforeJson: { identityConfirmed: false },
      afterJson: { identityConfirmed: true, code, name },
    });
  };

  // --- 1. the lifts: created when absent, otherwise left entirely alone --------
  for (const lift of LIFT_POSITIONS) {
    if (await byCode(lift.code)) {
      summary.untouched += 1;
      continue;
    }
    const created = await prisma.workResource.create({
      data: {
        siteId,
        code: lift.code,
        name: lift.name,
        resourceCategory: 'BAY',
        liftType: lift.liftType,
        maxVehicleWeight: 'STANDARD',
        requiresMechanic: true,
        supportsSedan: true,
        supportsSuv: true,
        schedulingEnabled: true,
        capacity: 1,
        capacityRole: 'PRIMARY_SERVICE_POSITION',
        physicalPosition: lift.position,
        identityConfirmedAt: now,
        identityConfirmedByUserId: actorUserId,
        notes: `${CR}: ${lift.position} as photographed. Lift rating NOT verified — confirm the plate before raising the weight class.`,
        occupancy: { create: { status: 'AVAILABLE' } },
      },
    });
    await audit({
      action: 'RESOURCE_CREATE',
      entityType: 'WorkResource',
      entityId: created.id,
      afterJson: { code: created.code, name: created.name, resourceCategory: created.resourceCategory, physicalPosition: lift.position },
    });
    await setCapabilities(created.id, created.code, LIFT_CAPABILITIES);
    await audit({
      action: 'RESOURCE_IDENTITY_CONFIRMED',
      entityType: 'WorkResource',
      entityId: created.id,
      beforeJson: { identityConfirmed: false },
      afterJson: { identityConfirmed: true, code: created.code, name: created.name },
    });
    summary.created.push(lift.code);
  }

  // --- 2. the ground positions: the overflow rows, classified while unclassified
  for (const ground of GROUND_POSITIONS) {
    const r = await byCode(ground.code);
    if (!r || r.retiredAt) {
      summary.skipped.push(`${ground.code} (absent or retired)`);
      continue;
    }
    if (String(r.capacityRole) !== 'UNVERIFIED') {
      summary.untouched += 1;
      continue;
    }
    await prisma.workResource.update({
      where: { id: r.id },
      data: {
        name: ground.name,
        capacityRole: 'OVERFLOW_SERVICE_POSITION',
        physicalPosition: ground.position,
        liftType: null,
        isActive: true,
        schedulingEnabled: true,
        notes: `${CR}: ${ground.position} — ground level, no lift, general work only. ${SOURCE}`,
      },
    });
    await audit({
      action: 'RESOURCE_UPDATE',
      entityType: 'WorkResource',
      entityId: r.id,
      beforeJson: { name: r.name, capacityRole: r.capacityRole, physicalPosition: r.physicalPosition },
      afterJson: { name: ground.name, capacityRole: 'OVERFLOW_SERVICE_POSITION', physicalPosition: ground.position },
    });
    await setCapabilities(r.id, ground.code, GROUND_CAPABILITIES);
    await confirmIdentity(r.id, ground.code, ground.name);
    summary.classified.push(ground.code);
  }

  // --- 3. the duplicate slot rows: retired while unclassified ------------------
  for (const code of DUPLICATE_SLOTS) {
    const r = await byCode(code);
    if (!r || r.retiredAt || String(r.capacityRole) !== 'UNVERIFIED') {
      summary.untouched += 1;
      continue;
    }
    if (r.occupancy?.status === 'OCCUPIED') {
      // A vehicle is recorded on it right now. Retiring would strand that record;
      // the next deploy picks it up once the vehicle has been released.
      summary.skipped.push(`${code} (a vehicle is on it)`);
      continue;
    }
    const reason = `${CR}: duplicate of ground positions 5 and 7 (OVF-01/OVF-02). ${SOURCE}`;
    await prisma.workResource.update({
      where: { id: r.id },
      data: {
        retiredAt: now,
        retiredByUserId: actorUserId,
        retireReason: reason,
        isActive: false,
        schedulingEnabled: false,
        showOnDispatchBoard: false,
      },
    });
    await audit({
      action: 'RESOURCE_RETIRE',
      entityType: 'WorkResource',
      entityId: r.id,
      beforeJson: { isActive: r.isActive },
      afterJson: { retiredAt: now },
      reasonCode: 'RESOURCE_RETIRE',
      notes: reason,
    });
    summary.retired.push(code);
  }

  // --- 4. equipment: never a position --------------------------------------------
  for (const code of SUPPORT_EQUIPMENT) {
    const r = await byCode(code);
    if (!r || r.retiredAt || String(r.capacityRole) !== 'UNVERIFIED') {
      summary.untouched += 1;
      continue;
    }
    await prisma.workResource.update({ where: { id: r.id }, data: { capacityRole: 'SUPPORT_EQUIPMENT' } });
    await audit({
      action: 'RESOURCE_UPDATE',
      entityType: 'WorkResource',
      entityId: r.id,
      beforeJson: { capacityRole: r.capacityRole },
      afterJson: { capacityRole: 'SUPPORT_EQUIPMENT', code },
    });
    summary.classified.push(code);
  }

  // --- 5. the wash area: a vehicle position for cleaning only --------------------
  {
    const r = await byCode(WASH.code);
    if (r && !r.retiredAt) {
      let touched = false;
      if (String(r.capacityRole) === 'UNVERIFIED' || !r.physicalPosition) {
        await prisma.workResource.update({
          where: { id: r.id },
          data: {
            ...(String(r.capacityRole) === 'UNVERIFIED' ? { capacityRole: 'PRIMARY_SERVICE_POSITION' } : {}),
            ...(r.physicalPosition ? {} : { physicalPosition: WASH.position }),
          },
        });
        await audit({
          action: 'RESOURCE_UPDATE',
          entityType: 'WorkResource',
          entityId: r.id,
          beforeJson: { capacityRole: r.capacityRole, physicalPosition: r.physicalPosition },
          afterJson: { capacityRole: 'PRIMARY_SERVICE_POSITION', physicalPosition: r.physicalPosition ?? WASH.position },
        });
        touched = true;
      }
      if (r.serviceCapabilities.length === 0) {
        await setCapabilities(r.id, r.code, WASH_CAPABILITIES);
        touched = true;
      }
      if (!r.identityConfirmedAt) {
        await confirmIdentity(r.id, r.code, r.name);
        touched = true;
      }
      if (touched) summary.classified.push(WASH.code);
      else summary.untouched += 1;
    }
  }

  // --- 6. the press: equipment, created when absent -----------------------------
  if (await byCode(PRESS.code)) {
    summary.untouched += 1;
  } else {
    const created = await prisma.workResource.create({
      data: {
        siteId,
        code: PRESS.code,
        name: PRESS.name,
        resourceCategory: 'BAY',
        liftType: null,
        maxVehicleWeight: null,
        requiresMechanic: true,
        supportsSedan: true,
        supportsSuv: true,
        schedulingEnabled: false,
        showOnDispatchBoard: false,
        capacity: 1,
        capacityRole: 'SUPPORT_EQUIPMENT',
        physicalPosition: PRESS.position,
        identityConfirmedAt: now,
        identityConfirmedByUserId: actorUserId,
        notes: `${CR}: equipment, not a vehicle position. Never scheduled; its status can be set by hand. ${SOURCE}`,
        occupancy: { create: { status: 'AVAILABLE' } },
      },
    });
    await audit({
      action: 'RESOURCE_CREATE',
      entityType: 'WorkResource',
      entityId: created.id,
      afterJson: { code: created.code, name: created.name, resourceCategory: created.resourceCategory, physicalPosition: PRESS.position },
    });
    summary.created.push(PRESS.code);
  }

  // --- 7. the legacy bay rows: closed out while unresolved -----------------------
  for (const code of LEGACY_BAY_CODES) {
    const bay = await prisma.workBay.findUnique({
      where: { siteId_code: { siteId, code } },
      include: { resource: { select: { code: true } }, _count: { select: { assignments: true } } },
    });
    if (!bay || bay.resource || String(bay.reconciliationDisposition) !== 'UNRESOLVED') {
      summary.untouched += 1;
      continue;
    }
    await prisma.workBay.update({
      where: { id: bay.id },
      data: {
        reconciliationDisposition: 'REPLACED',
        dispositionNote: LEGACY_BAY_NOTE,
        dispositionedAt: now,
        dispositionedByUserId: actorUserId,
      },
    });
    await audit({
      action: 'LEGACY_BAY_DISPOSITION',
      entityType: 'WorkBay',
      entityId: bay.id,
      beforeJson: { disposition: bay.reconciliationDisposition, note: bay.dispositionNote },
      afterJson: { disposition: 'REPLACED', note: LEGACY_BAY_NOTE, historicalAssignments: bay._count.assignments },
      notes: LEGACY_BAY_NOTE,
    });
    summary.dispositioned.push(code);
  }

  return summary;
}
