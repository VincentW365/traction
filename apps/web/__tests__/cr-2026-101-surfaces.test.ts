/**
 * CR-2026-101 — static surface checks (house style: source-level smoke tests).
 *
 * Pin the load-bearing facts of the technician workspace: read-only customer/
 * vehicle context with a report-instead-of-edit path, prominent concern,
 * dated history, typed notes, and the advisor attention surfaces.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const APP = path.resolve(__dirname, '../app');
const COMPONENTS = path.resolve(__dirname, '../components');
const read = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf8');

describe('technician job workspace (§1/§3/§4/§5)', () => {
  const src = read(APP, '(dashboard)/technician/jobs/[orderId]/page.tsx');

  it('shows customer and vehicle as read-only sections with NO edit mutations', () => {
    expect(src).toContain('Customer (read-only)');
    expect(src).toContain('Vehicle (read-only)');
    // No customer/vehicle write calls anywhere on this page.
    expect(src).not.toMatch(/api\.(patch|put|delete)\(`?\/(customers|vehicles)/);
    expect(src).not.toContain('/classification/');
  });

  it('reporting wrong information is a note to the advisor, not an edit', () => {
    expect(src).toContain('DATA_REPORT');
    expect(src).toContain('Incorrect information');
  });

  it('the concern, job sheet and inspection are one tap away', () => {
    expect(src).toContain('Customer concern');
    expect(src).toContain('VIEW JOB SHEET');
    expect(src).toContain('/inspections/job-sheet/');
  });

  it('service history always shows dates on previous inspections (§7)', () => {
    expect(src).toContain('Vehicle Service History');
    expect(src).toContain('an old inspection must never read as current');
  });

  it('authorization states are visible but not decidable here (§15)', () => {
    expect(src).toContain('Authorization pending');
    expect(src).toContain('The advisor handles customer authorization');
    // No decision endpoint is called from the technician workspace.
    expect(src).not.toContain('/decision');
  });
});

describe('typed notes (§13/§14)', () => {
  const src = read(COMPONENTS, 'visit-notes-card.tsx');
  it('distinguishes the six note kinds with author and timestamp', () => {
    for (const label of [
      'Customer concern',
      'Advisor note',
      'Manager instruction',
      'Technician note',
      'Safety concern',
      'Incorrect information',
    ]) {
      expect(src).toContain(label);
    }
    expect(src).toContain('authorName');
    expect(src).toContain('createdAt');
  });
});

describe('My Jobs workday view (§8/§10/§11/§12)', () => {
  const src = read(APP, '(dashboard)/technician/page.tsx');
  it('has the workday summary and every bucket', () => {
    expect(src).toContain("api.get('/service-orders/mine/workday')");
    expect(src).toContain('Your work today:');
    for (const bucket of ['Up Next', 'Waiting / On Hold', 'Rework', 'Awaiting QC', 'Completed Today']) {
      expect(src).toContain(bucket);
    }
  });
  it('cards carry concern, expected time and appointment chips', () => {
    expect(src).toContain('a.concern');
    expect(src).toContain('expectedMinutes');
    expect(src).toContain('appointmentAt');
  });
  it('every card opens the purpose-built workspace', () => {
    expect((src.match(/OpenJobLink orderId=/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

describe('advisor attention surfaces (§1/§14)', () => {
  it('dispatch board renders the Needs Attention panel with resolve', () => {
    const src = read(APP, '(dashboard)/dispatch/page.tsx');
    expect(src).toContain('Needs Attention');
    expect(src).toContain('/visit-notes/');
    expect(src).toContain('Mark Handled');
  });
  it('control center counts open attention items', () => {
    const src = read(APP, '(dashboard)/admin/dashboard/page.tsx');
    expect(src).toContain('attentionItems');
  });
  it('the visit workspace carries the typed-notes card', () => {
    const src = read(APP, '(dashboard)/queue/[id]/page.tsx');
    expect(src).toContain('VisitNotesCard');
  });
});
