/**
 * CR-2026-100 — static surface checks (house style: source-level smoke tests).
 *
 * Pin the load-bearing UI facts of the multi-job technician workflow, the pause
 * acknowledgement surfaces, and the Job Times report, so a refactor that
 * silently drops one of them fails here rather than on the shop floor.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const APP = path.resolve(__dirname, '../app');
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8');

describe('technician My Jobs (CR-2026-100 §1/§2/§4)', () => {
  const src = read('(dashboard)/technician/page.tsx');

  it('renders every workload bucket, not just a single current job', () => {
    expect(src).toContain('Waiting / On Hold');
    expect(src).toContain('Ready to Start');
    expect(src).toContain('Also In Progress');
    expect(src).toContain('Finished Today');
  });

  it('every job card reaches the job sheet in one tap', () => {
    expect(src).toContain('View Job Sheet');
    expect(src).toContain('/inspections/job-sheet/');
    // The link renders from a shared component used across all buckets.
    expect((src.match(/JobSheetLink visitId=/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('starting a second job goes through the explicit switch dialog, never silently', () => {
    expect(src).toContain('ACTIVE_WORK_ELSEWHERE');
    expect(src).toContain('HOLD IT & SWITCH');
    expect(src).toContain('holdReasonCode');
  });

  it('the technician sees the acknowledgement state of their own pause', () => {
    expect(src).toContain('awaiting advisor/manager acknowledgement');
  });

  it('static durations print without seconds (no frozen-seconds clocks)', () => {
    expect(src).toContain('function fmtMins');
  });
});

describe('pause approvals are visible, never buried (§9)', () => {
  it('dispatch board renders the pending panel with approve/reject', () => {
    const src = read('(dashboard)/dispatch/page.tsx');
    expect(src).toContain('Pause Approval Required');
    expect(src).toContain('/approve');
    expect(src).toContain('/reject');
    expect(src).toContain('pauseApprovals');
  });

  it('control center counts pending approvals as a stat', () => {
    const src = read('(dashboard)/admin/dashboard/page.tsx');
    expect(src).toContain('pendingPauseApprovals');
    expect(src).toContain('Pause Approvals');
  });

  it('the visit workspace can approve, reject (reasoned) and correct the start time', () => {
    const src = read('(dashboard)/queue/[id]/page.tsx');
    expect(src).toContain('pause-approvals/pending');
    expect(src).toContain('correct-start');
    expect(src).toContain('Adjust start time');
    // Advisor pause is honestly labelled as on-behalf (§7).
    expect(src).toContain('Pause on behalf');
  });
});

describe('Job Times report (§12–§17)', () => {
  const src = read('(dashboard)/reports/page.tsx');

  it('offers BOTH time bases as an explicit toggle', () => {
    expect(src).toContain('Elapsed Time');
    expect(src).toContain('Technician Work Time');
    expect(src).toContain("useState<TimeBasis>('ELAPSED')");
  });

  it('shows the waiting breakdown, not an unexplained average', () => {
    expect(src).toContain('Waiting Parts');
    expect(src).toContain('Waiting Customer');
    expect(src).toContain('Other Paused');
  });

  it('supports the required filters', () => {
    expect(src).toContain('technicianId');
    expect(src).toContain('vehicleClass');
    expect(src).toContain('sourceType');
  });

  it('prints from the SAME queries as the screen — one calculation path', () => {
    // The print header states period/filters/basis; the body is the on-screen
    // sections themselves (no second reporting pipeline).
    expect(src).toContain('window.print()');
    expect(src).toContain('hidden print:block');
    expect(src).toContain('Time basis:');
    expect(src).toContain('Generated:');
  });

  it('per-technician rows carry the §15 fields', () => {
    expect(src).toContain('Jobs Assigned');
    expect(src).toContain('Jobs Completed');
    expect(src).toContain('Productive Time');
    expect(src).toContain('Held / Waiting');
    expect(src).toContain('Elapsed Job Time');
  });
});

describe('report failures are stated, never disguised (§11)', () => {
  it('technician-kpi shows an error instead of "no completed jobs"', () => {
    const src = read('(dashboard)/reports/technician-kpi/page.tsx');
    expect(src).toContain('dash.isError');
    expect(src).toContain('Failed to load KPI results');
  });
  it('benchmark-review shows an error instead of a clean queue', () => {
    const src = read('(dashboard)/reports/benchmark-review/page.tsx');
    expect(src).toContain('queue.isError');
    expect(src).toContain('Failed to load the review queue');
  });
});

describe('vehicle type is automatic and correctable in one place (§10)', () => {
  it('the vehicle page shows the class and offers an audited correction', () => {
    const src = read('(dashboard)/vehicles/[id]/page.tsx');
    expect(src).toContain('serviceClass');
    expect(src).toContain('/vehicles/classification/');
    expect(src).toContain('Save (audited)');
  });
  it('the job sheet displays the class from the vehicle record', () => {
    const src = read('(dashboard)/inspections/job-sheet/[visitId]/page.tsx');
    expect(src).toContain('serviceClass');
  });
});
