/**
 * CR-2026-103 — static surface checks (house style: source-level smoke tests).
 *
 * Pin the dashboard restructure: statistics (My Workday) visually and
 * structurally separate from the operational job list (My Jobs), the fixed
 * scan order, registration-first cards, one primary action per state, useful
 * empty states, filtering, and the collapsed completed list.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.resolve(__dirname, '../app/(dashboard)/technician/page.tsx'),
  'utf8',
);

describe('statistics are separate from jobs (§1/§2/§6)', () => {
  it('My Workday and My Jobs are distinct labelled sections, in that order', () => {
    const workday = src.indexOf('My Workday');
    const jobs = src.indexOf('>My Jobs<');
    expect(workday).toBeGreaterThan(-1);
    expect(jobs).toBeGreaterThan(workday);
  });

  it('workday stats are compact cards incl. the personal Work Time', () => {
    expect(src).toContain('WorkdayStat');
    for (const label of ['Active', 'Up Next', 'Waiting', 'Rework', 'QC', 'Done', 'Work Time']) {
      expect(src).toContain(`label="${label}"`);
    }
    // The Waiting card carries the parts/customer split as supporting text.
    expect(src).toContain('waitingParts');
    expect(src).toContain('waitingCustomer');
  });

  it('workday-level time and job-level timers are different things', () => {
    // Personal statistic in the summary…
    expect(src).toContain('todayWorkMs');
    // …job timing inside the working card.
    expect(src).toContain('Elapsed');
    expect(src).toContain('fmtClock(workingMs)');
  });
});

describe('scan order and sections (§3/§16)', () => {
  it('sections appear in the fixed priority order', () => {
    // Section-specific markers (the filter row and stat labels reuse the words).
    const order = [
      'title="Working Now"',
      'title="Up Next"',
      'title="Waiting / Held"',
      'title="Rework"',
      'title="Awaiting QC"',
      'Completed Today</h3>',
    ];
    let last = -1;
    for (const marker of order) {
      const i = src.indexOf(marker);
      expect(i, `${marker} present`).toBeGreaterThan(-1);
      expect(i, `${marker} after previous section`).toBeGreaterThan(last);
      last = i;
    }
  });

  it('greeting header with the technician name', () => {
    expect(src).toContain('Good morning');
    expect(src).toContain('Good afternoon');
    expect(src).toContain('firstName');
  });

  it('Completed Today is collapsed by default', () => {
    expect(src).toContain('<details');
    expect(src).toMatch(/open=\{filter === 'DONE'\}/);
  });
});

describe('job cards (§4/§5/§8)', () => {
  it('registration leads every card', () => {
    // The hero and the shared PlateHeading both set the plate in large mono type.
    expect(src).toContain('PlateHeading');
    expect(src).toMatch(/font-black font-mono[\s\S]{0,160}\{currentJob\.plate\}/);
  });

  it('one clear primary action per state', () => {
    for (const action of ['START WORK', 'RESUME', 'ADDRESS REWORK', 'FINISHED → QC']) {
      expect(src).toContain(action);
    }
  });

  it('status badges per state, hold/rework styling distinct from active', () => {
    for (const badge of ['WORKING', 'UP NEXT', 'WAITING FOR PARTS', 'WAITING FOR CUSTOMER', 'REWORK', 'AWAITING QC']) {
      expect(src).toContain(badge);
    }
  });

  it('rework cards say WHY the job came back', () => {
    expect(src).toContain('QC feedback');
    expect(src).toContain('openRework');
  });
});

describe('empty states and filtering (§13/§14)', () => {
  it('each core section has a useful empty state', () => {
    expect(src).toContain('No job currently active.');
    expect(src).toContain('Select an assigned job below to begin.');
    expect(src).toContain('No jobs currently on hold.');
    expect(src).toContain('No rework assigned.');
    expect(src).toContain('Nothing awaiting QC.');
  });

  it('simple one-row filter over the job sections', () => {
    for (const f of ["'ALL'", "'ACTIVE'", "'UP_NEXT'", "'WAITING'", "'REWORK'", "'QC'", "'DONE'"]) {
      expect(src).toContain(f);
    }
  });
});

describe('multi-job logic preserved (§15)', () => {
  it('switch dialog, pause acknowledgement and workday clock survive the restyle', () => {
    expect(src).toContain('ACTIVE_WORK_ELSEWHERE');
    expect(src).toContain('HOLD IT & SWITCH');
    expect(src).toContain('awaiting advisor/manager acknowledgement');
    expect(src).toContain("api.get('/service-orders/mine/workday')");
  });
});
