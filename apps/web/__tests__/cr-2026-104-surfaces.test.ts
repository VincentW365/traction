/**
 * CR-2026-104 — static surface checks for the Performance Report page.
 *
 * Pin the management-report structure: controls separated from the document,
 * one shared payload, the section hierarchy, both time bases, honest
 * comparisons, explicit thresholds, definitions, print/export/naming.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.resolve(__dirname, '../app/(dashboard)/reports/page.tsx'),
  'utf8',
);

describe('one shared reporting model (§25)', () => {
  it('everything renders the single performance-report payload', () => {
    expect(src).toContain('/reports/performance-report?');
    // No parallel business logic: the old separate kpi/rework/job-times fetches are gone.
    expect(src).not.toContain('/reports/kpis?');
    expect(src).not.toContain('/reports/rework?');
    expect(src).not.toContain('/reports/job-times?');
  });
});

describe('controls vs report (§34), filters (§19), comparison (§20)', () => {
  it('report controls live in their own print-hidden toolbar', () => {
    expect(src).toContain('REPORT CONTROLS');
    expect(src).toContain('sticky top-0');
  });
  it('offers the §19 presets, filters and a reset', () => {
    for (const p of ['Today', 'Yesterday', 'This Week', 'Last Week', 'This Month', 'Last Month']) {
      expect(src).toContain(`label: '${p}'`);
    }
    expect(src).toContain('Reset Filters');
    expect(src).toContain('technicianId');
    expect(src).toContain('vehicleClass');
    expect(src).toContain('sourceType');
    expect(src).toContain('serviceTypeId');
  });
  it('compare-previous-period is a first-class control shown in the header', () => {
    expect(src).toContain('Compare previous period');
    expect(src).toContain('Compared with:');
  });
});

describe('the report document (§2–§18, §24, §26)', () => {
  it('has the section hierarchy of a management report', () => {
    const order = [
      'Executive Summary',
      'Service Time — Elapsed vs Technician Work',
      'Operational Flow',
      'Appointments vs Walk-Ins',
      'Vehicle Type Analysis',
      'Operational Delays',
      'Technician Performance',
      'Service Type Performance — Target vs Actual',
      'Quality — QC & Rework',
      'Metric Definitions',
    ];
    let last = -1;
    for (const title of order) {
      const i = src.indexOf(`title="${title}"`);
      expect(i, `${title} present`).toBeGreaterThan(-1);
      expect(i, `${title} in order`).toBeGreaterThan(last);
      last = i;
    }
  });
  it('keeps both time bases distinct with avg/median/max (§5/§6)', () => {
    expect(src).toContain('medianElapsedMs');
    expect(src).toContain('medianTechWorkMs');
    expect(src).toContain('maxElapsedMs');
    expect(src).toContain("useState<TimeBasis>('ELAPSED')");
  });
  it('a deterministic performance summary paragraph (§4)', () => {
    expect(src).toContain('Performance Summary');
    expect(src).toContain('largest recorded source of operational delay');
  });
  it('attention items show their explicit thresholds (§18)', () => {
    expect(src).toContain('Items Requiring Attention');
    expect(src).toContain('Threshold:');
  });
  it('unclassified vehicles are shown, not dropped (§9)', () => {
    expect(src).toContain('UNCLASSIFIED');
  });
  it('empty datasets say so instead of faking zeros (§29)', () => {
    expect(src).toContain('No records matched the selected reporting period and filters.');
  });
  it('technician drill-down makes the numbers explainable (§11)', () => {
    expect(src).toContain('job{t.jobs.length === 1');
    expect(src).toContain('/visits/${j.serviceVisitId}');
  });
});

describe('print, PDF naming and export (§21/§22/§31/§32)', () => {
  it('Print Report sets the §32 document name and prints', () => {
    expect(src).toContain('Print Report');
    expect(src).toContain('Berts-Service-Center-');
    expect(src).toContain('window.print()');
  });
  it('print keeps the letterhead + footer, hides chrome', () => {
    expect(src).toContain('Internal Management Use');
    expect(src).toContain('hidden print:block');
    expect((src.match(/print:hidden/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it('sections avoid mid-element page cuts', () => {
    expect(src).toContain("breakBefore: 'page'");
    expect((src.match(/breakInside: 'avoid'/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it('CSV detail export shares the same payload and filters', () => {
    expect(src).toContain('ExportMenu');
    expect(src).toContain('berts-performance-detail_');
  });
});
