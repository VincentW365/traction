/**
 * Test Data Sandbox — manifest (CR-2026-020, T-b).
 *
 * Every row a test run creates is tagged with an
 *   ExternalSystemRef(system=TEST_DATA_RUN, externalId=<runId>, entityType, entityId)
 * so cleanup (T-c) can delete EXACTLY the run's rows, graph-independently.
 *
 * `ManifestRecorder` collects (entityType, entityId) as scenarios create rows.
 * `collectRunFootprint` independently re-derives every row that belongs to the run
 * by walking the FK graph from the tagged anchors (Customer/Vehicle/ServiceVisit,
 * which carry testDataRunId) plus the polymorphic status/audit/notification rows.
 * `diffManifest` then proves the manifest is COMPLETE — any created-but-unmanifested
 * row (footprint − manifest) is a hard failure (cleanup would orphan it).
 */
import { Prisma, IntegrationSystem } from '@prisma/client';

export const TEST_DATA_RUN_SYSTEM: IntegrationSystem = IntegrationSystem.TEST_DATA_RUN;

export interface ManifestEntry {
  entityType: string;
  entityId: string;
}

const key = (e: ManifestEntry) => `${e.entityType}:${e.entityId}`;

/** Accumulates the entities a run creates (deduped). */
export class ManifestRecorder {
  private readonly seen = new Set<string>();
  readonly entries: ManifestEntry[] = [];

  add(entityType: string, entityId: string): void {
    const k = `${entityType}:${entityId}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.entries.push({ entityType, entityId });
  }

  countsByTable(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) out[e.entityType] = (out[e.entityType] ?? 0) + 1;
    return out;
  }

  anchorIds(): { customerIds: string[]; vehicleIds: string[]; visitIds: string[] } {
    const pick = (t: string) => this.entries.filter((e) => e.entityType === t).map((e) => e.entityId);
    return { customerIds: pick('Customer'), vehicleIds: pick('Vehicle'), visitIds: pick('ServiceVisit') };
  }
}

/** Write one TEST_DATA_RUN ExternalSystemRef per created row. */
export async function writeManifest(
  tx: Prisma.TransactionClient,
  runId: string,
  label: string,
  entries: ManifestEntry[],
): Promise<number> {
  for (const e of entries) {
    await tx.externalSystemRef.create({
      data: {
        system: TEST_DATA_RUN_SYSTEM,
        entityType: e.entityType,
        entityId: e.entityId,
        externalId: runId,
        syncStatus: 'SYNCED',
        metadata: { label, runId },
      },
    });
  }
  return entries.length;
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

/**
 * Re-derive every row belonging to the run by walking FKs from the tagged anchors.
 * Pure-read; safe to run inside the create transaction (sees its own writes).
 */
export async function collectRunFootprint(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<{ entries: ManifestEntry[]; byTable: Record<string, number> }> {
  const out: ManifestEntry[] = [];
  const all = new Set<string>(); // every entity id seen, for the polymorphic sweep
  const push = (entityType: string, rowIds: string[]) => {
    for (const id of rowIds) {
      out.push({ entityType, entityId: id });
      all.add(id);
    }
  };

  // Anchors (carry testDataRunId)
  const customerIds = ids(await tx.customer.findMany({ where: { testDataRunId: runId }, select: { id: true } }));
  const vehicleIds = ids(await tx.vehicle.findMany({ where: { testDataRunId: runId }, select: { id: true } }));
  const visitIds = ids(await tx.serviceVisit.findMany({ where: { testDataRunId: runId }, select: { id: true } }));
  push('Customer', customerIds);
  push('Vehicle', vehicleIds);
  push('ServiceVisit', visitIds);

  // Customer/Vehicle descendants
  const apptIds = ids(await tx.appointment.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } }));
  push('Appointment', apptIds);
  push('AppointmentService', ids(await tx.appointmentService.findMany({ where: { appointmentId: { in: apptIds } }, select: { id: true } })));
  push('VehicleClassification', ids(await tx.vehicleClassification.findMany({ where: { vehicleId: { in: vehicleIds } }, select: { id: true } })));
  push('VehicleSpecSnapshot', ids(await tx.vehicleSpecSnapshot.findMany({ where: { vehicleId: { in: vehicleIds } }, select: { id: true } })));
  push('FluidSpecSnapshot', ids(await tx.fluidSpecSnapshot.findMany({ where: { vehicleId: { in: vehicleIds } }, select: { id: true } })));

  // Visit descendants
  push('QueueTicket', ids(await tx.queueTicket.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } })));
  push('QueueDecision', ids(await tx.queueDecision.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } })));
  push('QueueEvent', ids(await tx.queueEvent.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } })));
  push('TransportRequest', ids(await tx.transportRequest.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } })));
  push('ResourceOccupancy', ids(await tx.resourceOccupancy.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } })));
  push('ResourceReservation', ids(await tx.resourceReservation.findMany({ where: { appointmentId: { in: apptIds } }, select: { id: true } })));

  // Order descendants
  const orderIds = ids(await tx.serviceOrder.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } }));
  push('ServiceOrder', orderIds);
  push('ServiceOrderItem', ids(await tx.serviceOrderItem.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } })));
  push('TechnicianAssignment', ids(await tx.technicianAssignment.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } })));
  push('ServiceOrderPause', ids(await tx.serviceOrderPause.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } })));
  push('ServiceOrderRework', ids(await tx.serviceOrderRework.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } })));
  push('PosReference', ids(await tx.posReference.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } })));

  const prIds = ids(await tx.partsRequest.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } }));
  push('PartsRequest', prIds);
  const priIds = ids(await tx.partsRequestItem.findMany({ where: { partsRequestId: { in: prIds } }, select: { id: true } }));
  push('PartsRequestItem', priIds);
  push('PartsReservation', ids(await tx.partsReservation.findMany({ where: { partsRequestItemId: { in: priIds } }, select: { id: true } })));
  push('InventoryTransfer', ids(await tx.inventoryTransfer.findMany({ where: { partsRequestId: { in: prIds } }, select: { id: true } })));

  push('MaintenanceRecommendation', ids(await tx.maintenanceRecommendation.findMany({ where: { vehicleId: { in: vehicleIds } }, select: { id: true } })));
  push('MaintenanceReminder', ids(await tx.maintenanceReminder.findMany({ where: { vehicleId: { in: vehicleIds } }, select: { id: true } })));

  // Polymorphic rows referencing any created entity (ids are brand-new → no
  // pre-existing rows can reference them, so any match was created by this run).
  const allIds = [...all];
  push('StatusHistory', ids(await tx.statusHistory.findMany({ where: { entityId: { in: allIds } }, select: { id: true } })));
  push('AuditLog', ids(await tx.auditLog.findMany({ where: { entityId: { in: allIds } }, select: { id: true } })));
  push('NotificationLog', ids(await tx.notificationLog.findMany({ where: { entityId: { in: allIds } }, select: { id: true } })));

  const byTable: Record<string, number> = {};
  for (const e of out) byTable[e.entityType] = (byTable[e.entityType] ?? 0) + 1;
  return { entries: out, byTable };
}

/**
 * Compare the independently-walked footprint against the recorded manifest.
 *  - missing: in footprint but NOT manifested → cleanup would orphan it (FAIL).
 *  - extra:   manifested but not found in footprint → benign for cleanup (warn).
 */
export function diffManifest(
  footprint: ManifestEntry[],
  manifest: ManifestEntry[],
): { missing: ManifestEntry[]; extra: ManifestEntry[] } {
  const manifestKeys = new Set(manifest.map(key));
  const footprintKeys = new Set(footprint.map(key));
  const missing = footprint.filter((e) => !manifestKeys.has(key(e)));
  const extra = manifest.filter((e) => !footprintKeys.has(key(e)));
  return { missing, extra };
}

export class ManifestIncompleteError extends Error {
  constructor(public readonly missing: ManifestEntry[]) {
    super(
      `Manifest incomplete: ${missing.length} created row(s) were not tagged: ` +
        missing.slice(0, 10).map(key).join(', ') + (missing.length > 10 ? ' …' : ''),
    );
    this.name = 'ManifestIncompleteError';
  }
}
