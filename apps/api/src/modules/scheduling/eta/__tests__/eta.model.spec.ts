import { describe, it, expect } from 'vitest';
import { computeSiteEta, resolvePlannedMinutes, workedMinutes, type EtaInServiceVisit } from '../eta.model';
import { ETA_DEFAULTS, etaConfigFromRules } from '../eta.config';

/**
 * CR-2026-105b — the pure ETA model. No I/O. Every scenario management listed:
 * normal appointment, waiting customer, early/late start, pause, resume, delay,
 * reassignment, completion — the time-projection half lives here; the
 * classification half lives in eta-presentation.spec.ts.
 */

const T0 = new Date('2026-09-11T14:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const cfg = { ...ETA_DEFAULTS, capacity: 2 };

describe('resolvePlannedMinutes — precedence', () => {
  it('prefers a fixed KPI standard over everything else', () => {
    expect(resolvePlannedMinutes({ kpiStandardMinutes: 120, orderItems: [{ estimateMinutes: 60 }] }, 80)).toBe(120);
  });
  it('then Σ item estimates', () => {
    expect(resolvePlannedMinutes({ orderItems: [{ estimateMinutes: 30, baseDurationMinutes: 45 }, { estimateMinutes: 20 }] }, 80)).toBe(50);
  });
  it('then Σ catalogue base durations on items', () => {
    expect(resolvePlannedMinutes({ orderItems: [{ estimateMinutes: 0, baseDurationMinutes: 45 }, { baseDurationMinutes: 15 }] }, 80)).toBe(60);
  });
  it('then appointment services × qty', () => {
    expect(resolvePlannedMinutes({ appointmentServices: [{ baseDurationMinutes: 30, qty: 2 }] }, 80)).toBe(60);
  });
  it('falls back to the configured default (management: 80)', () => {
    expect(resolvePlannedMinutes({}, 80)).toBe(80);
    expect(resolvePlannedMinutes({ orderItems: [{ estimateMinutes: null, baseDurationMinutes: null }] }, 80)).toBe(80);
  });
});

describe('workedMinutes — holds excluded (docs/114 time model)', () => {
  it('subtracts closed pauses and the open pause', () => {
    const v: EtaInServiceVisit = {
      serviceVisitId: 'v', startedAt: min(-60), plannedMinutes: 80, closedPauseMinutes: 10, openPauseStartedAt: min(-5), stage: 'HOLD',
    };
    // 60 elapsed − 10 closed − 5 open = 45
    expect(workedMinutes(v, T0)).toBe(45);
  });
});

describe('computeSiteEta — in-service projections', () => {
  it('IN_PROGRESS: completion = now + (planned − worked)', () => {
    const [r] = computeSiteEta(T0, cfg, [
      { serviceVisitId: 'a', startedAt: min(-30), plannedMinutes: 80, closedPauseMinutes: 0, openPauseStartedAt: null, stage: 'IN_PROGRESS' },
    ], []);
    expect(r.basis).toBe('IN_SERVICE');
    expect(r.estimatedStartAt).toEqual(min(-30));
    expect(r.estimatedCompleteAt).toEqual(min(50));
    expect(r.remainingMinutes).toBe(50);
  });

  it('service that started LATE still projects from its actual start', () => {
    const [r] = computeSiteEta(T0, cfg, [
      { serviceVisitId: 'a', startedAt: min(-10), plannedMinutes: 80, closedPauseMinutes: 0, openPauseStartedAt: null, stage: 'IN_PROGRESS' },
    ], []);
    expect(r.estimatedCompleteAt).toEqual(min(70));
  });

  it('never goes below the minimum remaining floor once over the planned time', () => {
    const [r] = computeSiteEta(T0, cfg, [
      { serviceVisitId: 'a', startedAt: min(-200), plannedMinutes: 80, closedPauseMinutes: 0, openPauseStartedAt: null, stage: 'IN_PROGRESS' },
    ], []);
    expect(r.remainingMinutes).toBe(cfg.minRemainingMinutes);
    expect(r.estimatedCompleteAt).toEqual(min(cfg.minRemainingMinutes));
  });

  it('PAUSE holds the clock: the remaining work does not shrink while on hold', () => {
    const paused: EtaInServiceVisit = {
      serviceVisitId: 'a', startedAt: min(-30), plannedMinutes: 80, closedPauseMinutes: 0, openPauseStartedAt: min(-10), stage: 'HOLD',
    };
    const atT0 = computeSiteEta(T0, cfg, [paused], [])[0];
    const later = computeSiteEta(min(20), cfg, [paused], [])[0];
    expect(atT0.basis).toBe('HOLD');
    // worked = 30 − 10 = 20 → remaining 60, republished from each `now`
    expect(atT0.remainingMinutes).toBe(60);
    expect(later.remainingMinutes).toBe(60);
    expect(atT0.estimatedCompleteAt).toEqual(min(60));
    expect(later.estimatedCompleteAt).toEqual(min(80));
  });

  it('RESUME: the closed pause is excluded and the clock runs again', () => {
    const [r] = computeSiteEta(T0, cfg, [
      { serviceVisitId: 'a', startedAt: min(-60), plannedMinutes: 80, closedPauseMinutes: 20, openPauseStartedAt: null, stage: 'IN_PROGRESS' },
    ], []);
    // worked = 60 − 20 = 40 → remaining 40
    expect(r.estimatedCompleteAt).toEqual(min(40));
  });

  it('QC: completion = now + qc allowance', () => {
    const [r] = computeSiteEta(T0, cfg, [
      { serviceVisitId: 'a', startedAt: min(-90), plannedMinutes: 80, closedPauseMinutes: 0, openPauseStartedAt: null, stage: 'QC' },
    ], []);
    expect(r.basis).toBe('QC');
    expect(r.estimatedCompleteAt).toEqual(min(cfg.qcMinutes));
  });
});

describe('computeSiteEta — waiting customers on N tracks', () => {
  const busy: EtaInServiceVisit = {
    serviceVisitId: 'busy', startedAt: min(-50), plannedMinutes: 80, closedPauseMinutes: 0, openPauseStartedAt: null, stage: 'IN_PROGRESS',
  }; // finishes at +30

  it('places ranked cars on the earliest-free track in rank order', () => {
    const results = computeSiteEta(T0, cfg, [busy], [
      { serviceVisitId: 'r1', position: 1, plannedMinutes: 80 },
      { serviceVisitId: 'r2', position: 2, plannedMinutes: 80 },
      { serviceVisitId: 'r3', position: 3, plannedMinutes: 80 },
    ]);
    const by = Object.fromEntries(results.map((r) => [r.serviceVisitId, r]));
    // capacity 2: one free track now, one busy until +30
    expect(by.r1.estimatedStartAt).toEqual(min(5)); // now + overhead
    expect(by.r1.estimatedCompleteAt).toEqual(min(85));
    expect(by.r2.estimatedStartAt).toEqual(min(35)); // +30 free + overhead
    expect(by.r2.estimatedCompleteAt).toEqual(min(115));
    expect(by.r3.estimatedStartAt).toEqual(min(90)); // earliest is r1's track at +85
    expect(by.r3.estimatedCompleteAt).toEqual(min(170));
    expect(by.r1.basis).toBe('QUEUED');
  });

  it('a normal appointment not yet arrived is not part of the site projection (handled by presentation)', () => {
    const results = computeSiteEta(T0, cfg, [], []);
    expect(results).toEqual([]);
  });

  it('blocked cars (no position) get no time', () => {
    const [r] = computeSiteEta(T0, cfg, [], [{ serviceVisitId: 'b', position: null, plannedMinutes: 80 }]);
    expect(r).toMatchObject({ basis: 'BLOCKED', estimatedStartAt: null, estimatedCompleteAt: null });
  });

  it('a rework assumes only the configured share of the planned time', () => {
    const [r] = computeSiteEta(T0, cfg, [], [{ serviceVisitId: 'w', position: 1, plannedMinutes: 80, isRework: true }]);
    expect(r.remainingMinutes).toBe(40);
    expect(r.estimatedCompleteAt).toEqual(min(5 + 40));
  });

  it('tracks expand when more cars are in service than the configured capacity', () => {
    const three = ['a', 'b', 'c'].map((id) => ({ ...busy, serviceVisitId: id }));
    const results = computeSiteEta(T0, { ...cfg, capacity: 1 }, three, [{ serviceVisitId: 'w', position: 1, plannedMinutes: 80 }]);
    const w = results.find((r) => r.serviceVisitId === 'w')!;
    // three tracks all busy until +30 → the waiting car starts at +35, not after two 80-minute jobs
    expect(w.estimatedStartAt).toEqual(min(35));
  });

  it('ranking inputs are never emitted (FIFO guardrail)', () => {
    const [r] = computeSiteEta(T0, cfg, [], [{ serviceVisitId: 'w', position: 1, plannedMinutes: 80 }]);
    expect(Object.keys(r).sort()).toEqual(['basis', 'estimatedCompleteAt', 'estimatedStartAt', 'remainingMinutes', 'serviceVisitId']);
  });
});

describe('etaConfigFromRules', () => {
  it('site rows win over global rows and invalid values fall back to defaults', () => {
    const cfgOut = etaConfigFromRules([
      { ruleKey: 'booking_max_concurrent_appointments', valueJson: 4, siteId: null },
      { ruleKey: 'booking_max_concurrent_appointments', valueJson: 3, siteId: 'site' },
      { ruleKey: 'eta_qc_minutes', valueJson: 'ten', siteId: 'site' },
      { ruleKey: 'eta_rework_factor', valueJson: 2, siteId: 'site' },
      { ruleKey: 'default_appointment_duration_minutes', valueJson: 80, siteId: 'site' },
    ]);
    expect(cfgOut.capacity).toBe(3);
    expect(cfgOut.qcMinutes).toBe(ETA_DEFAULTS.qcMinutes);
    expect(cfgOut.reworkFactor).toBe(ETA_DEFAULTS.reworkFactor);
    expect(cfgOut.defaultDurationMinutes).toBe(80);
  });
});
