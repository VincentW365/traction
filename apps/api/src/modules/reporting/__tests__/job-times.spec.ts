import { describe, it, expect, vi } from 'vitest';
import { JobTimesService, mergedDurationMs } from '../job-times.service';
import { localDayRange } from '../date-range';

describe('localDayRange (CR-2026-100 — the operator\'s calendar day)', () => {
  it('spans the full local day, never a UTC/local mix', () => {
    // The old pattern lost most of the working day west of UTC: "today" reports
    // came back empty because the end bound landed on the previous local day.
    const { start, end } = localDayRange('2026-09-01', '2026-09-01');
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([2026, 8, 1, 0]);
    expect([end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([1, 23, 59, 59]);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000 - 1);
  });
});

/**
 * CR-2026-100 — Scenarios G and H.
 *
 * G: the same completed job shows different but mathematically correct elapsed
 *    time (wall clock, holds included) and technician work time (labour
 *    segments only) — one is never derived by renaming the other.
 * H: one technician across several assignments never produces physically
 *    impossible labour: overlapping intervals merge before summing.
 */

const T = (iso: string) => new Date(iso);

describe('mergedDurationMs (the §15 no-double-counting primitive)', () => {
  it('sums disjoint intervals', () => {
    expect(
      mergedDurationMs([
        { start: 0, end: 10 },
        { start: 20, end: 35 },
      ]),
    ).toBe(25);
  });

  it('overlapping intervals count once — never more than the clock', () => {
    // 60 min + 60 min fully overlapping = 60 min of real time, not 120.
    expect(
      mergedDurationMs([
        { start: 0, end: 60 },
        { start: 0, end: 60 },
      ]),
    ).toBe(60);
    // Partial overlap: 0-40 and 30-60 = 60, not 70.
    expect(
      mergedDurationMs([
        { start: 0, end: 40 },
        { start: 30, end: 60 },
      ]),
    ).toBe(60);
  });

  it('ignores zero/negative-length intervals and handles emptiness', () => {
    expect(mergedDurationMs([])).toBe(0);
    expect(mergedDurationMs([{ start: 10, end: 10 }])).toBe(0);
  });
});

function build(orders: any[], segments: any[]) {
  const prisma: any = {
    serviceOrder: { findMany: vi.fn(async () => orders) },
    technicianWorkSegment: { findMany: vi.fn(async () => segments) },
  };
  return { service: new JobTimesService(prisma as any), prisma };
}

const baseVisit = {
  visitNumber: 'V-260901-001',
  sourceType: 'WALKIN',
  customer: { firstName: 'Jane', lastName: 'Doe' },
  vehicle: { plateNumber: 'ABC123', serviceClass: 'SUV_CLASS' },
  queueTicket: { ticketNumber: 'B01-260901-001' },
};

const techBob = {
  technicianId: 'tech-1',
  technician: { employeeCode: 'T-01', userAccount: { fullName: 'Bob Smith' } },
};

describe('Scenario G — elapsed vs technician work time on one job', () => {
  it('elapsed includes the hold; work time is labour only; the breakdown explains the gap', async () => {
    // 09:00 start → 11:18 completed = 2h18m elapsed.
    // Labour: 09:00–09:56 and 10:38–10:56 = 74 min. Waiting parts: 09:56–10:38 = 42 min.
    const order = {
      id: 'so-1',
      status: 'QC',
      startedAt: T('2026-09-01T09:00:00Z'),
      completedAt: T('2026-09-01T11:18:00Z'),
      items: [{ serviceType: { id: 'st-1', name: 'Brake Job' } }],
      pauses: [
        {
          reasonCode: 'WAITING_PARTS',
          startedAt: T('2026-09-01T09:56:00Z'),
          endedAt: T('2026-09-01T10:38:00Z'),
        },
        {
          reasonCode: 'CUSTOMER_AUTHORIZATION',
          startedAt: T('2026-09-01T10:56:00Z'),
          endedAt: T('2026-09-01T11:18:00Z'),
        },
      ],
      assignments: [techBob],
      serviceVisit: baseVisit,
    };
    const segments = [
      { serviceOrderId: 'so-1', technicianId: 'tech-1', startedAt: T('2026-09-01T09:00:00Z'), endedAt: T('2026-09-01T09:56:00Z') },
      { serviceOrderId: 'so-1', technicianId: 'tech-1', startedAt: T('2026-09-01T10:38:00Z'), endedAt: T('2026-09-01T10:56:00Z') },
    ];
    const h = build([order], segments);

    const res = await h.service.getJobTimes('site-1', '2026-09-01', '2026-09-01');
    const job = res.jobs[0];

    expect(job.elapsedMs).toBe(138 * 60_000); // 2h18m — wall clock, holds included
    expect(job.techWorkMs).toBe(74 * 60_000); // 1h14m — labour segments only
    expect(job.waitingPartsMs).toBe(42 * 60_000);
    expect(job.waitingCustomerMs).toBe(22 * 60_000);
    expect(job.otherPausedMs).toBe(0);
    // The two bases are different numbers derived from different records.
    expect(job.techWorkMs).not.toBe(job.elapsedMs);

    // The summary carries both bases from the same rows (screen = print).
    expect(res.summary.totalElapsedMs).toBe(job.elapsedMs);
    expect(res.summary.totalTechWorkMs).toBe(job.techWorkMs);
  });
});

describe('Scenario H — multiple assignments never double-count one person', () => {
  it('overlapping segments across two orders yield physically possible productive time', async () => {
    // Legacy/bad data: Bob has overlapping open-hours on TWO orders 09:00–11:00
    // each. Naive summing says 4h of labour in a 2h window; the merged union
    // says 2h — the physical truth.
    const mkOrder = (id: string) => ({
      id,
      status: 'QC',
      startedAt: T('2026-09-01T09:00:00Z'),
      completedAt: T('2026-09-01T11:00:00Z'),
      items: [{ serviceType: { id: 'st-1', name: 'Service' } }],
      pauses: [],
      assignments: [techBob],
      serviceVisit: baseVisit,
    });
    const segments = [
      { serviceOrderId: 'so-A', technicianId: 'tech-1', startedAt: T('2026-09-01T09:00:00Z'), endedAt: T('2026-09-01T11:00:00Z') },
      { serviceOrderId: 'so-B', technicianId: 'tech-1', startedAt: T('2026-09-01T09:00:00Z'), endedAt: T('2026-09-01T11:00:00Z') },
    ];
    const h = build([mkOrder('so-A'), mkOrder('so-B')], segments);

    const res = await h.service.getJobTimes('site-1', '2026-09-01', '2026-09-01');
    const bob = res.byTechnician.find((t) => t.technicianId === 'tech-1')!;

    expect(bob.jobsAssigned).toBe(2);
    expect(bob.jobsCompleted).toBe(2);
    // 2 hours, NOT 4 — the same real hour is never counted twice for one person.
    expect(bob.productiveMs).toBe(2 * 60 * 60_000);
  });

  it('two technicians genuinely working at once IS additive labour on the job', async () => {
    const techAmy = {
      technicianId: 'tech-2',
      technician: { employeeCode: 'T-02', userAccount: { fullName: 'Amy Lee' } },
    };
    const order = {
      id: 'so-1',
      status: 'QC',
      startedAt: T('2026-09-01T09:00:00Z'),
      completedAt: T('2026-09-01T10:00:00Z'),
      items: [{ serviceType: { id: 'st-1', name: 'Service' } }],
      pauses: [],
      assignments: [techBob, techAmy],
      serviceVisit: baseVisit,
    };
    const segments = [
      { serviceOrderId: 'so-1', technicianId: 'tech-1', startedAt: T('2026-09-01T09:00:00Z'), endedAt: T('2026-09-01T10:00:00Z') },
      { serviceOrderId: 'so-1', technicianId: 'tech-2', startedAt: T('2026-09-01T09:00:00Z'), endedAt: T('2026-09-01T10:00:00Z') },
    ];
    const h = build([order], segments);

    const res = await h.service.getJobTimes('site-1', '2026-09-01', '2026-09-01');
    // Job-level labour: two people for one hour = two labour-hours. Real.
    expect(res.jobs[0].techWorkMs).toBe(2 * 60 * 60_000);
    // Per-person productive time stays physically bounded.
    for (const t of res.byTechnician) expect(t.productiveMs).toBe(60 * 60_000);
  });
});
