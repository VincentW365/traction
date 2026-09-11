import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-105c — static surface checks for self-service booking: the public
 * pages exist outside the dashboard, show the required steps and confirmation
 * content, never render staff-only shapes, and the report/nav/settings are wired.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('CR-2026-105c — customer self-service booking', () => {
  it('public booking pages live outside the authenticated route group and use the public fetch helper', () => {
    for (const p of ['app/book/page.tsx', 'app/book/manage/[token]/page.tsx', 'app/book/error.tsx', 'app/book/slot-picker.tsx', 'lib/public-api.ts']) {
      expect(fs.existsSync(path.join(root, p)), p).toBe(true);
    }
    const book = read('app/book/page.tsx');
    expect(book).toContain("from '../../lib/public-api'");
    expect(book).not.toContain('api-client');
    expect(book).not.toContain('sessionStorage');
  });

  it('the wizard covers identify → vehicle → service → time → confirm, and the confirmed page names every required fact', () => {
    const book = read('app/book/page.tsx');
    for (const s of ["'identify'", "'details'", "'service'", "'slot'", "'confirm'", "'done'"]) expect(book).toContain(s);
    for (const label of ['Appointment Confirmed', 'Date & arrival time', 'Vehicle', 'Service', 'Expected service time', 'Service centre', 'View, move or cancel']) {
      expect(book).toContain(label);
    }
    expect(read('app/book/slot-picker.tsx')).toContain('Next available appointment');
    expect(book).toContain('SLOT_TAKEN');
  });

  it('customer-facing pages render masked identifiers only', () => {
    const book = read('app/book/page.tsx');
    const manage = read('app/book/manage/[token]/page.tsx');
    expect(book).toContain('plateMasked');
    expect(manage).toContain('plateMasked');
    expect(manage).not.toContain('plateNumber');
    expect(manage).not.toContain('/queue/');
  });

  it('manage page offers cancel and reschedule with the rule reasons', () => {
    const manage = read('app/book/manage/[token]/page.tsx');
    for (const s of ['Move appointment', 'Cancel appointment', 'cancelBlockedReason', 'rescheduleBlockedReason', 'Confirm new time']) expect(manage).toContain(s);
  });

  it('staff new-appointment page handles the capacity warning (warn-not-block)', () => {
    const src = read('app/(dashboard)/appointments/new/page.tsx');
    expect(src).toContain("'CAPACITY_FULL'");
    expect(src).toContain('acknowledgeCapacity: true');
  });

  it('Appointments & Bookings report page, nav and hub are wired; booking rules are editable', () => {
    const report = read('app/(dashboard)/reports/appointments/page.tsx');
    for (const s of ['Appointments & Bookings', 'No-show rate', 'Utilisation', 'Estimated vs actual completion', 'ExportMenu', 'Print Report']) expect(report).toContain(s);
    expect(read('components/sidebar.tsx')).toContain("href: '/reports/appointments'");
    expect(read('app/(dashboard)/reports/page.tsx')).toContain('href="/reports/appointments"');
    const settings = read('app/(dashboard)/admin/settings/page.tsx');
    for (const k of ["'booking_enabled'", "'booking_max_concurrent_appointments'", "'appointment_duration_source'", "'booking_closed_dates'"]) expect(settings).toContain(k);
  });
});
