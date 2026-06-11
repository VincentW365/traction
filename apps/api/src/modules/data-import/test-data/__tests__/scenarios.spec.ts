import { describe, it, expect, vi } from 'vitest';
import {
  SCENARIOS,
  RunAllocator,
  resolveScenarioKeys,
  summarizePlans,
  expandScenarioKeys,
  DEFAULT_SCENARIO_KEYS,
  ALL_SCENARIO_KEYS,
  type ScenarioContext,
} from '../scenarios';
import { ManifestRecorder } from '../manifest';

const CTX: ScenarioContext = {
  siteId: 'site-1',
  advisorUserId: 'user-1',
  technicianId: 'tech-1',
  bayId: 'bay-1',
  generalServiceTypeId: 'svc-1',
  generalServiceTypeDuration: 30,
  transportServiceTypeId: 'tsvc-1',
  runId: '00000000-1111-2222-3333-444444444444',
  label: 'vw-test',
  runShort: '00000000',
};

function mockCreateTx(): any {
  let n = 0;
  const tx: any = {};
  const models = [
    'customer', 'vehicle', 'serviceVisit', 'queueTicket', 'appointment', 'appointmentService',
    'serviceOrder', 'serviceOrderItem', 'technicianAssignment', 'transportRequest', 'statusHistory', 'auditLog',
  ];
  for (const m of models) tx[m] = { create: vi.fn(async () => ({ id: `${m}-${++n}` })) };
  return tx;
}

describe('scenario drift guard — run() creates EXACTLY plan', () => {
  for (const key of ALL_SCENARIO_KEYS) {
    it(`${key}: actual creation counts equal the static plan`, async () => {
      const tx = mockCreateTx();
      const rec = new ManifestRecorder();
      await SCENARIOS[key].run(tx, CTX, rec, new RunAllocator(1));
      expect(rec.countsByTable()).toEqual(SCENARIOS[key].plan);
    });
  }
});

describe('anchors are tagged, fake, and CUST-numbered', () => {
  it('customer = VWTEST name + CUST- number + run tag; vehicle tagged sedan', async () => {
    const tx = mockCreateTx();
    const rec = new ManifestRecorder();
    await SCENARIOS.walkin.run(tx, CTX, rec, new RunAllocator(42));

    const custData = tx.customer.create.mock.calls[0][0].data;
    expect(custData.firstName).toBe('VWTEST');
    expect(custData.customerNumber).toMatch(/^CUST-\d{6}$/);
    expect(custData.customerNumber).toBe('CUST-000042'); // from allocator start
    expect(custData.customerNumber.startsWith('VWTEST')).toBe(false);
    expect(custData.testDataRunId).toBe(CTX.runId);
    expect(custData.email).toContain('@example.test');

    const vehData = tx.vehicle.create.mock.calls[0][0].data;
    expect(vehData.testDataRunId).toBe(CTX.runId);
    expect(vehData.serviceClass).toBe('SEDAN_CLASS');
    expect(vehData.vehicleCode).toMatch(/^SC-VWT-/);
  });

  it('every created row is recorded for the manifest (recorder count == create-call count)', async () => {
    const tx = mockCreateTx();
    const rec = new ManifestRecorder();
    await SCENARIOS.completed.run(tx, CTX, rec, new RunAllocator(1));
    const createCalls = Object.values(tx).reduce(
      (sum: number, model: any) => sum + (model.create?.mock.calls.length ?? 0),
      0,
    );
    expect(rec.entries.length).toBe(createCalls);
  });
});

describe('scenario selection + plan summary helpers', () => {
  it('resolveScenarioKeys: default / all / explicit / unknown', () => {
    expect(resolveScenarioKeys(undefined)).toEqual(DEFAULT_SCENARIO_KEYS);
    expect(resolveScenarioKeys('all')).toEqual(ALL_SCENARIO_KEYS);
    expect(resolveScenarioKeys('walkin,abandon')).toEqual(['walkin', 'abandon']);
    expect(() => resolveScenarioKeys('nope')).toThrow(/Unknown scenario/);
  });

  it('summarizePlans aggregates per-table counts with repeat', () => {
    const s = summarizePlans(['walkin'], 3);
    // walkin = 5 rows × 3
    expect(s.totals).toEqual({ Customer: 3, Vehicle: 3, ServiceVisit: 3, QueueTicket: 3, StatusHistory: 3 });
    expect(s.totalRows).toBe(15);
  });

  it('expandScenarioKeys repeats the selection', () => {
    expect(expandScenarioKeys(['a', 'b'], 2)).toEqual(['a', 'b', 'a', 'b']);
  });
});
