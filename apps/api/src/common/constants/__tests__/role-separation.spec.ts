import { describe, it, expect } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../permissions';

/**
 * CR-2026-101 §2/§19 — role separation is a BACKEND fact, not hidden buttons.
 *
 * The technician role gets read access and technician-owned workflows, and
 * must never hold a permission that writes customer/vehicle master data,
 * appointments, pricing/config, staff, or queue administration. Every write
 * endpoint in the API is guarded by one of these permission keys, so pinning
 * the role→permission map pins what a technician can reach through direct
 * URL access, hand-built requests, or dev tools.
 */

const tech = new Set(ROLE_PERMISSIONS.TECHNICIAN);

describe('technician permissions — reads and technician-owned work only', () => {
  it('holds the read/workflow permissions the workspace needs', () => {
    for (const p of [
      PERMISSIONS.QUEUE_VIEW, // queue board, visit record, job sheet, visit notes (read)
      PERMISSIONS.SERVICE_ORDER_VIEW, // their job, context, vehicle history
      PERMISSIONS.SERVICE_ORDER_STATUS, // start/pause/resume/QC + notes (kind-gated)
      PERMISSIONS.INSPECTION_VIEW,
      PERMISSIONS.INSPECTION_CREATE,
      PERMISSIONS.INSPECTION_EDIT,
    ]) {
      expect(tech.has(p), `technician should hold ${p}`).toBe(true);
    }
  });

  it('holds NO customer/vehicle master-data write permissions', () => {
    for (const p of [
      PERMISSIONS.CUSTOMER_CREATE,
      PERMISSIONS.CUSTOMER_UPDATE,
      PERMISSIONS.VEHICLE_CREATE,
      PERMISSIONS.VEHICLE_UPDATE, // also gates classification confirm
    ]) {
      expect(tech.has(p), `technician must NOT hold ${p}`).toBe(false);
    }
  });

  it('holds NO appointment, order-administration or queue-override permissions', () => {
    for (const p of [
      PERMISSIONS.APPOINTMENT_CREATE,
      PERMISSIONS.APPOINTMENT_UPDATE,
      PERMISSIONS.APPOINTMENT_CANCEL,
      PERMISSIONS.APPOINTMENT_CONFIRM,
      PERMISSIONS.CHECKIN_PERFORM,
      PERMISSIONS.WALKIN_CREATE,
      PERMISSIONS.SERVICE_ORDER_CREATE,
      PERMISSIONS.SERVICE_ORDER_UPDATE, // edit/delete/approve orders
      PERMISSIONS.SERVICE_ORDER_ASSIGN, // assign + pause review + note resolution
      PERMISSIONS.QUEUE_OVERRIDE,
      PERMISSIONS.QUEUE_ABANDON,
    ]) {
      expect(tech.has(p), `technician must NOT hold ${p}`).toBe(false);
    }
  });

  it('holds NO configuration, staff, reporting-admin or notification permissions', () => {
    const forbiddenKeys = Object.entries(PERMISSIONS)
      .filter(([name]) =>
        /CONFIG|STAFF|RULE|REPORT_VIEW|NOTIFY|TEMPLATE|RESOURCE_MANAGE|MAINTENANCE_OVERRIDE/.test(name),
      )
      .map(([, value]) => value);
    expect(forbiddenKeys.length).toBeGreaterThan(0);
    for (const p of forbiddenKeys) {
      expect(tech.has(p), `technician must NOT hold ${p}`).toBe(false);
    }
  });

  it('advisor and manager keep the administrative side', () => {
    const advisor = new Set(ROLE_PERMISSIONS.SERVICE_ADVISOR);
    expect(advisor.has(PERMISSIONS.CUSTOMER_UPDATE)).toBe(true);
    expect(advisor.has(PERMISSIONS.VEHICLE_UPDATE)).toBe(true);
    expect(advisor.has(PERMISSIONS.SERVICE_ORDER_ASSIGN)).toBe(true);
    const admin = new Set(ROLE_PERMISSIONS.ADMIN);
    expect(admin.has(PERMISSIONS.CUSTOMER_UPDATE)).toBe(true);
  });
});
