import { describe, it, expect, vi } from 'vitest';
import {
  ManifestRecorder,
  writeManifest,
  collectRunFootprint,
  diffManifest,
  TEST_DATA_RUN_SYSTEM,
  type ManifestEntry,
} from '../manifest';

describe('ManifestRecorder', () => {
  it('dedupes and counts by table; exposes anchor ids', () => {
    const rec = new ManifestRecorder();
    rec.add('Customer', 'c1');
    rec.add('Customer', 'c1'); // dup ignored
    rec.add('Vehicle', 'v1');
    rec.add('ServiceVisit', 'sv1');
    rec.add('StatusHistory', 'sh1');
    expect(rec.entries).toHaveLength(4);
    expect(rec.countsByTable()).toEqual({ Customer: 1, Vehicle: 1, ServiceVisit: 1, StatusHistory: 1 });
    expect(rec.anchorIds()).toEqual({ customerIds: ['c1'], vehicleIds: ['v1'], visitIds: ['sv1'] });
  });
});

describe('writeManifest', () => {
  it('creates one TEST_DATA_RUN ExternalSystemRef per entry', async () => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'ref' }));
    const tx: any = { externalSystemRef: { create } };
    const entries: ManifestEntry[] = [
      { entityType: 'Customer', entityId: 'c1' },
      { entityType: 'ServiceVisit', entityId: 'sv1' },
    ];
    const n = await writeManifest(tx, 'run-1', 'lbl', entries);
    expect(n).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].data).toMatchObject({
      system: TEST_DATA_RUN_SYSTEM,
      entityType: 'Customer',
      entityId: 'c1',
      externalId: 'run-1',
    });
    expect(create.mock.calls[1][0].data).toMatchObject({ entityType: 'ServiceVisit', entityId: 'sv1', externalId: 'run-1' });
  });
});

describe('diffManifest (completeness)', () => {
  const fp: ManifestEntry[] = [
    { entityType: 'Customer', entityId: 'c1' },
    { entityType: 'ServiceVisit', entityId: 'sv1' },
    { entityType: 'StatusHistory', entityId: 'sh1' },
  ];

  it('no missing/extra when manifest == footprint', () => {
    const { missing, extra } = diffManifest(fp, [...fp]);
    expect(missing).toHaveLength(0);
    expect(extra).toHaveLength(0);
  });

  it('detects a created-but-unmanifested row as MISSING (cleanup orphan risk)', () => {
    const manifest = fp.filter((e) => e.entityId !== 'sh1'); // forgot to record sh1
    const { missing } = diffManifest(fp, manifest);
    expect(missing).toEqual([{ entityType: 'StatusHistory', entityId: 'sh1' }]);
  });

  it('reports a manifested-but-not-found row as EXTRA (benign)', () => {
    const manifest = [...fp, { entityType: 'Ghost', entityId: 'g1' }];
    const { missing, extra } = diffManifest(fp, manifest);
    expect(missing).toHaveLength(0);
    expect(extra).toEqual([{ entityType: 'Ghost', entityId: 'g1' }]);
  });
});

describe('collectRunFootprint (graph walk)', () => {
  // Build a mock tx where every model.findMany returns [] unless overridden.
  const MODELS = [
    'customer', 'vehicle', 'serviceVisit', 'appointment', 'appointmentService',
    'vehicleClassification', 'vehicleSpecSnapshot', 'fluidSpecSnapshot', 'queueTicket',
    'queueDecision', 'queueEvent', 'transportRequest', 'resourceOccupancy', 'resourceReservation',
    'serviceOrder', 'serviceOrderItem', 'technicianAssignment', 'serviceOrderPause',
    'serviceOrderRework', 'posReference', 'partsRequest', 'partsRequestItem', 'partsReservation',
    'inventoryTransfer', 'maintenanceRecommendation', 'maintenanceReminder',
    'statusHistory', 'auditLog', 'notificationLog',
  ];
  function mockTx(overrides: Record<string, Array<{ id: string }>>): any {
    const tx: any = {};
    for (const m of MODELS) {
      tx[m] = { findMany: vi.fn(async () => overrides[m] ?? []) };
    }
    return tx;
  }

  it('walks anchors → children → polymorphic and aggregates by entityType', async () => {
    const tx = mockTx({
      customer: [{ id: 'c1' }],
      vehicle: [{ id: 'v1' }],
      serviceVisit: [{ id: 'sv1' }],
      queueTicket: [{ id: 'qt1' }],
      statusHistory: [{ id: 'sh1' }],
    });
    const { entries, byTable } = await collectRunFootprint(tx, 'run-1');
    expect(byTable).toMatchObject({ Customer: 1, Vehicle: 1, ServiceVisit: 1, QueueTicket: 1, StatusHistory: 1 });
    // anchors queried by testDataRunId
    expect(tx.customer.findMany).toHaveBeenCalledWith({ where: { testDataRunId: 'run-1' }, select: { id: true } });
    // polymorphic sweep includes the created ids (c1,v1,sv1,qt1) — not sh1 (it IS the row)
    const shCall = tx.statusHistory.findMany.mock.calls[0][0];
    expect(shCall.where.entityId.in).toEqual(expect.arrayContaining(['c1', 'v1', 'sv1', 'qt1']));
    expect(entries).toEqual(expect.arrayContaining([{ entityType: 'StatusHistory', entityId: 'sh1' }]));
  });
});
