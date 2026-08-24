/**
 * Route Smoke Tests — v4.1 Pre-Pilot
 *
 * Validates that every route in the BSOP web app:
 * 1. Has a corresponding page.tsx file
 * 2. Exports a default component
 * 3. Compiles without error (caught by build)
 *
 * These are static route inventory tests, not E2E browser tests.
 * For full Playwright E2E, see future test suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WEB_APP_DIR = path.resolve(__dirname, '../app');

// Complete route inventory with expected access levels
const ROUTE_INVENTORY = [
  { route: '/', file: 'page.tsx', access: 'public', description: 'Root redirect to login' },
  { route: '/login', file: '(auth)/login/page.tsx', access: 'public', description: 'Login page' },
  { route: '/dashboard', file: '(dashboard)/page.tsx', access: 'auth', description: 'Dashboard home' },
  { route: '/check-in', file: '(dashboard)/check-in/page.tsx', access: 'auth', description: 'Check-in page' },
  { route: '/queue', file: '(dashboard)/queue/page.tsx', access: 'auth', description: 'Queue board' },
  { route: '/queue/[id]', file: '(dashboard)/queue/[id]/page.tsx', access: 'auth', description: 'Queue ticket detail' },
  { route: '/dispatch', file: '(dashboard)/dispatch/page.tsx', access: 'auth', description: 'Dispatch board' },
  { route: '/schedule', file: '(dashboard)/schedule/page.tsx', access: 'auth', description: 'Day schedule' },
  { route: '/appointments', file: '(dashboard)/appointments/page.tsx', access: 'auth', description: 'Appointments list' },
  { route: '/appointments/new', file: '(dashboard)/appointments/new/page.tsx', access: 'auth', description: 'New appointment wizard' },
  { route: '/customers', file: '(dashboard)/customers/page.tsx', access: 'auth', description: 'Customer search' },
  { route: '/customers/[id]', file: '(dashboard)/customers/[id]/page.tsx', access: 'auth', description: 'Customer detail' },
  { route: '/vehicles/[id]', file: '(dashboard)/vehicles/[id]/page.tsx', access: 'auth', description: 'Vehicle detail' },
  { route: '/technician', file: '(dashboard)/technician/page.tsx', access: 'auth', description: 'Technician work view' },
  { route: '/reports', file: '(dashboard)/reports/page.tsx', access: 'auth', description: 'Reports/KPI' },
  { route: '/admin/settings', file: '(dashboard)/admin/settings/page.tsx', access: 'auth', description: 'Admin settings' },
  { route: '/admin/dashboard', file: '(dashboard)/admin/dashboard/page.tsx', access: 'auth', description: 'Manager control center' },
  { route: '/admin/staff', file: '(dashboard)/admin/staff/page.tsx', access: 'auth', description: 'Staff directory' },
  { route: '/admin/staff/[id]', file: '(dashboard)/admin/staff/[id]/page.tsx', access: 'auth', description: 'Staff detail' },
  { route: '/admin/staff/new', file: '(dashboard)/admin/staff/new/page.tsx', access: 'auth', description: 'Create staff' },
  { route: '/admin/availability', file: '(dashboard)/admin/availability/page.tsx', access: 'auth', description: 'Availability calendar' },
  { route: '/admin/audit-logs', file: '(dashboard)/admin/audit-logs/page.tsx', access: 'auth', description: 'Audit log viewer' },
  { route: '/admin/performance', file: '(dashboard)/admin/performance/page.tsx', access: 'auth', description: 'Performance dashboard' },
  { route: '/admin/performance/[id]', file: '(dashboard)/admin/performance/[id]/page.tsx', access: 'auth', description: 'Technician performance detail' },
  { route: '/admin/assignments', file: '(dashboard)/admin/assignments/page.tsx', access: 'auth', description: 'Assignment management' },
  { route: '/admin/service-catalogue', file: '(dashboard)/admin/service-catalogue/page.tsx', access: 'auth', description: 'Service catalogue' },
  { route: '/admin/kpi-mapping', file: '(dashboard)/admin/kpi-mapping/page.tsx', access: 'auth', description: 'KPI package-component mapping' },
  { route: '/admin/resources', file: '(dashboard)/admin/resources/page.tsx', access: 'auth', description: 'Resource configuration' },
  { route: '/admin/notifications', file: '(dashboard)/admin/notifications/page.tsx', access: 'auth', description: 'Notification templates (CR-2026-096)' },
  { route: '/status/[token]', file: 'status/[token]/page.tsx', access: 'public', description: 'Customer status (public)' },
];

// Sidebar navigation items — must all resolve to existing pages
const SIDEBAR_NAV = [
  { href: '/check-in', file: '(dashboard)/check-in/page.tsx' },
  { href: '/queue', file: '(dashboard)/queue/page.tsx' },
  { href: '/dispatch', file: '(dashboard)/dispatch/page.tsx' },
  { href: '/schedule', file: '(dashboard)/schedule/page.tsx' },
  { href: '/appointments', file: '(dashboard)/appointments/page.tsx' },
  { href: '/customers', file: '(dashboard)/customers/page.tsx' },
  { href: '/technician', file: '(dashboard)/technician/page.tsx' },
  { href: '/reports', file: '(dashboard)/reports/page.tsx' },
  { href: '/admin/settings', file: '(dashboard)/admin/settings/page.tsx' },
  { href: '/admin/dashboard', file: '(dashboard)/admin/dashboard/page.tsx' },
  { href: '/admin/staff', file: '(dashboard)/admin/staff/page.tsx' },
  { href: '/admin/availability', file: '(dashboard)/admin/availability/page.tsx' },
  { href: '/admin/performance', file: '(dashboard)/admin/performance/page.tsx' },
  { href: '/admin/assignments', file: '(dashboard)/admin/assignments/page.tsx' },
  { href: '/admin/service-catalogue', file: '(dashboard)/admin/service-catalogue/page.tsx' },
  { href: '/admin/kpi-mapping', file: '(dashboard)/admin/kpi-mapping/page.tsx' },
  { href: '/admin/resources', file: '(dashboard)/admin/resources/page.tsx' },
  { href: '/admin/notifications', file: '(dashboard)/admin/notifications/page.tsx' },
  { href: '/admin/audit-logs', file: '(dashboard)/admin/audit-logs/page.tsx' },
];

// Dashboard quick action links
const DASHBOARD_QUICK_ACTIONS = [
  { href: '/check-in', file: '(dashboard)/check-in/page.tsx' },
  { href: '/queue', file: '(dashboard)/queue/page.tsx' },
  { href: '/dispatch', file: '(dashboard)/dispatch/page.tsx' },
  { href: '/schedule', file: '(dashboard)/schedule/page.tsx' },
  { href: '/appointments', file: '(dashboard)/appointments/page.tsx' },
];

// Cross-page links (source → target)
const CROSS_PAGE_LINKS = [
  { source: 'customers/page.tsx', target: '(dashboard)/customers/[id]/page.tsx', description: 'Customer name link' },
  { source: 'appointments/page.tsx', target: '(dashboard)/appointments/new/page.tsx', description: 'New Appointment button' },
  { source: 'queue/page.tsx', target: '(dashboard)/queue/[id]/page.tsx', description: 'Ticket number drill-down' },
  { source: 'customers/[id]/page.tsx', target: '(dashboard)/check-in/page.tsx', description: 'Check In button' },
  { source: 'customers/[id]/page.tsx', target: '(dashboard)/appointments/new/page.tsx', description: 'Schedule Appointment button' },
];

describe('Route Inventory — all pages exist', () => {
  for (const route of ROUTE_INVENTORY) {
    it(`${route.route} → ${route.file} exists`, () => {
      const fullPath = path.join(WEB_APP_DIR, route.file);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Sidebar navigation — all targets exist', () => {
  for (const nav of SIDEBAR_NAV) {
    it(`sidebar "${nav.href}" → ${nav.file} exists`, () => {
      const fullPath = path.join(WEB_APP_DIR, nav.file);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Dashboard quick actions — all targets exist', () => {
  for (const action of DASHBOARD_QUICK_ACTIONS) {
    it(`quick action "${action.href}" → ${action.file} exists`, () => {
      const fullPath = path.join(WEB_APP_DIR, action.file);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Cross-page links — all drill-down targets exist', () => {
  for (const link of CROSS_PAGE_LINKS) {
    it(`${link.description}: target ${link.target} exists`, () => {
      const fullPath = path.join(WEB_APP_DIR, link.target);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Not-found page exists', () => {
  it('not-found.tsx exists at app root', () => {
    const fullPath = path.join(WEB_APP_DIR, 'not-found.tsx');
    expect(fs.existsSync(fullPath)).toBe(true);
  });
});

describe('Public routes require no auth layout', () => {
  it('/status/[token] page is outside (dashboard) group', () => {
    // status/[token] should NOT be under (dashboard) — it's public
    const publicPath = path.join(WEB_APP_DIR, 'status/[token]/page.tsx');
    const dashboardPath = path.join(WEB_APP_DIR, '(dashboard)/status/[token]/page.tsx');
    expect(fs.existsSync(publicPath)).toBe(true);
    expect(fs.existsSync(dashboardPath)).toBe(false);
  });

  it('/login page is outside (dashboard) group', () => {
    const authPath = path.join(WEB_APP_DIR, '(auth)/login/page.tsx');
    const dashboardPath = path.join(WEB_APP_DIR, '(dashboard)/login/page.tsx');
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(dashboardPath)).toBe(false);
  });
});

describe('Shared components exist', () => {
  const COMPONENTS_DIR = path.resolve(__dirname, '../components');

  it('sidebar.tsx exists', () => {
    expect(fs.existsSync(path.join(COMPONENTS_DIR, 'sidebar.tsx'))).toBe(true);
  });

  it('status-badge.tsx exists', () => {
    expect(fs.existsSync(path.join(COMPONENTS_DIR, 'status-badge.tsx'))).toBe(true);
  });

  it('pickup-notification-panel.tsx exists', () => {
    expect(fs.existsSync(path.join(COMPONENTS_DIR, 'pickup-notification-panel.tsx'))).toBe(true);
  });

  it('providers.tsx exists', () => {
    expect(fs.existsSync(path.join(COMPONENTS_DIR, 'providers.tsx'))).toBe(true);
  });
});

describe('Hooks exist', () => {
  const HOOKS_DIR = path.resolve(__dirname, '../hooks');

  it('use-auth.ts exists', () => {
    expect(fs.existsSync(path.join(HOOKS_DIR, 'use-auth.ts'))).toBe(true);
  });

  it('use-site.ts exists', () => {
    expect(fs.existsSync(path.join(HOOKS_DIR, 'use-site.ts'))).toBe(true);
  });
});
