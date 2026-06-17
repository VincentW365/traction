/**
 * Dev-only one-click login profiles (CR-2026-022; consolidated CR-2026-048).
 * Pure mapping. Three staff roles after the role merge:
 *  - ADMIN (shown as "Manager") reuses the existing admin account.
 *  - SERVICE_ADVISOR (front office) and TECHNICIAN map to dedicated DEVTEST users.
 * CUSTOMER is intentionally NOT included (not a staff role).
 */
export type DevLoginGroup = 'Administration' | 'Front Office' | 'Workshop';

export interface DevLoginProfile {
  role: string;
  email: string; // canonical/default mapping email
  displayName: string;
  group: DevLoginGroup;
  permissionsSummary: string;
  reuseExistingAdmin?: boolean;
}

export const DEV_LOGIN_PROFILES: DevLoginProfile[] = [
  { role: 'ADMIN', email: 'admin@bert.local', displayName: 'Manager', group: 'Administration', permissionsSummary: 'Full system access', reuseExistingAdmin: true },
  { role: 'SERVICE_ADVISOR', email: 'devtest.advisor@berts.local', displayName: 'DEVTEST Service Advisor', group: 'Front Office', permissionsSummary: 'Customers, appointments, check-in, queue, service orders, parts, transport' },
  { role: 'TECHNICIAN', email: 'devtest.tech@berts.local', displayName: 'DEVTEST Technician', group: 'Workshop', permissionsSummary: 'Queue, service-order status, inspections' },
];

export const DEV_LOGIN_ROLES = DEV_LOGIN_PROFILES.map((p) => p.role);

export function findDevProfile(role: string): DevLoginProfile | undefined {
  return DEV_LOGIN_PROFILES.find((p) => p.role === role);
}
