/**
 * CR-2026-102 — static surface checks (house style: source-level smoke tests).
 *
 * Pin the navigation corrections: the vehicle from Ticket Details opens the
 * technician-safe view, customer names are not directory gateways for
 * technicians, the Service Request is prominent, and no technician-visible
 * control leads to a predictable 403.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const APP = path.resolve(__dirname, '../app');
const COMPONENTS = path.resolve(__dirname, '../components');
const read = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf8');

describe('Ticket Details adapts to the technician role (§1/§4/§6/§8)', () => {
  const src = read(APP, '(dashboard)/queue/[id]/page.tsx');

  it('vehicle click routes technicians to the technician-safe view', () => {
    expect(src).toContain('/technician/vehicles/${sv.vehicle.id}');
  });

  it('customer name is plain text for technicians, a link for staff', () => {
    expect(src).toMatch(/isTechnician \?[\s\S]{0,200}sv\.customer\.firstName/);
  });

  it('the Service Request is its own prominent section', () => {
    expect(src).toContain('Service Request');
    expect(src).toContain('Reason for visit');
    expect(src).toContain('Requested services');
  });

  it('advisor-only actions are role-gated, never dead 403 buttons', () => {
    // Override, completion and customer communication all require permissions
    // technicians do not hold.
    expect(src).toMatch(/canOverride =\s*\n?\s*canManageOrders/);
    expect(src).toContain('canManageOrders && showCompletionSection');
    expect(src).toMatch(/canManageOrders && \(\s*\n?\s*<div className="card mb-6">\s*\n?\s*<div className="card-header flex items-center justify-between">\s*\n?\s*<h2 className="text-sm font-semibold text-slate-900">Customer Communication/);
  });
});

describe('technician-safe vehicle view (§1/§3/§10)', () => {
  const src = read(APP, '(dashboard)/technician/vehicles/[vehicleId]/page.tsx');

  it('reads the contextual endpoint, not the admin record', () => {
    expect(src).toContain('/operational');
    expect(src).not.toMatch(/api\.get\(`\/vehicles\/\$\{vehicleId\}`\)/);
  });

  it('is strictly read-only: no edit/delete/classification mutations', () => {
    expect(src).not.toMatch(/api\.(patch|put|delete)\(/);
    expect(src).not.toContain('/classification/');
    expect(src).toContain('Incorrect information');
  });

  it('carries current visit, jobs, job sheet, inspection and dated history', () => {
    expect(src).toContain('Current Visit');
    expect(src).toContain('VIEW JOB SHEET');
    expect(src).toContain('Service History');
    expect(src).toContain('an old inspection must never read as current');
  });
});

describe('no dead-end navigation for technicians (§8/§12)', () => {
  it('the Visit Record adapts its customer/vehicle links', () => {
    const src = read(APP, '(dashboard)/visits/[id]/page.tsx');
    expect(src).toContain('/technician/vehicles/${v.vehicle.id}');
    expect(src).toMatch(/isTechnician \?[\s\S]{0,120}customerName/);
  });

  it('global search hides customer rows and reroutes vehicle rows for technicians', () => {
    const src = read(COMPONENTS, 'global-search.tsx');
    expect(src).toContain('!isTechnician && r.customers.length');
    expect(src).toContain("isTechnician ? `/technician/vehicles/${v.id}`");
  });

  it('the admin vehicle page redirects technicians to their view instead of erroring', () => {
    const src = read(APP, '(dashboard)/vehicles/[id]/page.tsx');
    expect(src).toContain('Open Vehicle (technician view)');
    expect(src).toContain('!isTechnician');
  });

  it('the customer directory page gives technicians a clean card, not a raw 403', () => {
    const src = read(APP, '(dashboard)/customers/[id]/page.tsx');
    expect(src).toContain('Back to My Jobs');
    expect(src).toContain('!isTechnician');
  });

  it('the job workspace vehicle opens the technician-safe view', () => {
    const src = read(APP, '(dashboard)/technician/jobs/[orderId]/page.tsx');
    expect(src).toContain('/technician/vehicles/${vehicle.id}');
  });
});
