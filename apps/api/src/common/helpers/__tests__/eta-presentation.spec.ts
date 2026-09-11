import { describe, it, expect } from 'vitest';
import { presentEta, roundToFiveMinutes, toPublicEta } from '../eta-presentation';
import { ETA_PRESENTATION_DEFAULTS } from '../../../modules/scheduling/eta/eta.config';

/**
 * CR-2026-105b — the one read-side presentation: confidence classes, ranges,
 * rounding, terminal suppression, public projection. Pure; no I/O.
 */

const T0 = new Date('2026-09-11T14:02:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const cfg = ETA_PRESENTATION_DEFAULTS;

const base = {
  now: T0,
  visitStatus: 'QUEUED',
  queueRank: 1 as number | null,
  orderStatuses: [] as string[],
  promisedCompletionAt: null as Date | null,
  scheduledStartAt: null as Date | null,
  currentEtaStartAt: min(10) as Date | null,
  currentEtaCompleteAt: min(90) as Date | null,
  lastUpdatedAt: T0 as Date | null,
  config: cfg,
};

describe('presentEta — terminal and missing', () => {
  it('shows nothing once the visit is READY_FOR_PICKUP / CLOSED', () => {
    for (const s of ['READY_FOR_PICKUP', 'CLOSED', 'ABANDONED', 'CANCELLED']) {
      const p = presentEta({ ...base, visitStatus: s });
      expect(p.terminal).toBe(true);
      expect(p.estimatedCompletion).toBeNull();
      expect(p.publicState).toBeNull();
    }
  });

  it('a blocked car (no position, not in service) reads DELAYED with no time', () => {
    const p = presentEta({ ...base, queueRank: null, currentEtaStartAt: null, currentEtaCompleteAt: null });
    expect(p).toMatchObject({ confidence: 'DELAYED', publicState: 'DELAYED', estimatedCompletion: null });
  });

  it('no projection yet → nothing, not a guess', () => {
    const p = presentEta({ ...base, currentEtaStartAt: null, currentEtaCompleteAt: null });
    expect(p.confidence).toBeNull();
    expect(p.estimatedCompletion).toBeNull();
  });
});

describe('presentEta — waiting customer', () => {
  it('next in line: ON_TRACK with a ±10 min range, rounded to 5 minutes', () => {
    const p = presentEta(base);
    expect(p.confidence).toBe('ON_TRACK');
    expect(p.showRange).toBe(true);
    // start 14:12 → rounded 14:10; ±10 → 14:00 / 14:20
    expect(p.estimatedStart).toEqual({
      at: '2026-09-11T14:10:00.000Z', min: '2026-09-11T14:00:00.000Z', max: '2026-09-11T14:20:00.000Z',
    });
    expect(p.estimatedCompletion?.at).toBe('2026-09-11T15:30:00.000Z');
  });

  it('range widens with cars ahead and caps; a capped range reads AT_RISK', () => {
    const p4 = presentEta({ ...base, queueRank: 4 }); // 10 + 5×3 = 25
    expect(p4.estimatedStart?.min).toBe('2026-09-11T13:45:00.000Z');
    expect(p4.estimatedStart?.max).toBe('2026-09-11T14:35:00.000Z');
    expect(p4.confidence).toBe('ON_TRACK');
    const p9 = presentEta({ ...base, queueRank: 9 }); // 10 + 40 = 50 → cap 45
    expect(p9.confidence).toBe('AT_RISK');
  });

  it('appointment: start after the slot + margin → DELAYED; within margin → AT_RISK; on time → ON_TRACK', () => {
    const slot = min(0);
    expect(presentEta({ ...base, scheduledStartAt: slot, currentEtaStartAt: min(20) }).confidence).toBe('DELAYED');
    expect(presentEta({ ...base, scheduledStartAt: slot, currentEtaStartAt: min(10) }).confidence).toBe('AT_RISK');
    expect(presentEta({ ...base, scheduledStartAt: slot, currentEtaStartAt: min(-5) }).confidence).toBe('ON_TRACK');
  });
});

describe('presentEta — in service', () => {
  const inService = { ...base, visitStatus: 'IN_SERVICE', queueRank: null, orderStatuses: ['IN_PROGRESS'], currentEtaStartAt: min(-30) };

  it('on track: a single time, no start shown', () => {
    const p = presentEta(inService);
    expect(p.confidence).toBe('ON_TRACK');
    expect(p.showRange).toBe(false);
    expect(p.estimatedStart).toBeNull();
    expect(p.estimatedCompletion?.min).toBe(p.estimatedCompletion?.max);
  });

  it('paused / waiting on parts → DELAYED (public: DELAYED)', () => {
    for (const s of ['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER']) {
      const p = presentEta({ ...inService, orderStatuses: [s] });
      expect(p.confidence).toBe('DELAYED');
      expect(p.publicState).toBe('DELAYED');
    }
  });

  it('past the promised time → DELAYED; close to it → AT_RISK', () => {
    expect(presentEta({ ...inService, promisedCompletionAt: min(-1) }).confidence).toBe('DELAYED');
    expect(presentEta({ ...inService, promisedCompletionAt: min(95) }).confidence).toBe('AT_RISK');
  });

  it('past its own estimate (+grace) → DELAYED; nearly there → AT_RISK; QC is not "nearly there"', () => {
    expect(presentEta({ ...inService, currentEtaCompleteAt: min(-1) }).confidence).toBe('DELAYED');
    expect(presentEta({ ...inService, currentEtaCompleteAt: min(10) }).confidence).toBe('AT_RISK');
    expect(presentEta({ ...inService, visitStatus: 'QC', orderStatuses: ['QC'], currentEtaCompleteAt: min(10) }).confidence).toBe('ON_TRACK');
  });

  it('reassignment does not change the reading (statuses unchanged)', () => {
    const a = presentEta(inService);
    const b = presentEta({ ...inService, lastUpdatedAt: min(3) });
    expect(b.confidence).toBe(a.confidence);
    expect(b.estimatedCompletion).toEqual(a.estimatedCompletion);
  });
});

describe('helpers', () => {
  it('rounds to the nearest 5 minutes', () => {
    expect(roundToFiveMinutes(new Date('2026-09-11T14:02:00Z')).toISOString()).toBe('2026-09-11T14:00:00.000Z');
    expect(roundToFiveMinutes(new Date('2026-09-11T14:03:00Z')).toISOString()).toBe('2026-09-11T14:05:00.000Z');
  });

  it('toPublicEta strips confidence and last-update (privacy/no jargon)', () => {
    const pub = toPublicEta(presentEta(base));
    expect(Object.keys(pub).sort()).toEqual(['estimatedCompletion', 'estimatedStart', 'publicState', 'showRange']);
    expect(pub).not.toHaveProperty('confidence');
  });
});
