/**
 * Dev-only one-click login profiles (CR-2026-022, D-a). Pure mapping.
 *
 * ADMIN reuses the existing admin account (resolved at runtime — prefer
 * admin@bert.local, else the first ACTIVE ADMIN). The six non-admin roles map to
 * dedicated DEVTEST users (created later in D-b; until then they show as
 * unavailable / devLogin refuses clearly). CUSTOMER is intentionally NOT included.
 */
export type DevLoginGroup = 'Administration' | 'Front Office' | 'Workshop' | 'Parts / Transport';

export interface DevLoginProfile {
  role: string;
  email: string; // canonical/default mapping email
  displayName: string;
  group: DevLoginGroup;
  permissionsSummary: string;
  reuseExistingAdmin?: boolean;
}

export const DEV_LOGIN_PROFILES: DevLoginProfile[] = [
  { role: 'ADMIN', email: 'admin@bert.local', displayName: 'Admin User', group: 'Administration', permissionsSummary: 'Full system access', reuseExistingAdmin: true },
  { role: 'MANAGER', email: 'devtest.manager@berts.local', displayName: 'DEVTEST Manager', group: 'Administration', permissionsSummary: 'Management: directory, config, audit, reports, staff' },
  { role: 'SERVICE_ADVISOR', email: 'devtest.advisor@berts.local', displayName: 'DEVTEST Service Advisor', group: 'Front Office', permissionsSummary: 'Appointments, service orders, parts/transport' },
  { role: 'FRONT_DESK', email: 'devtest.frontdesk@berts.local', displayName: 'DEVTEST Front Desk', group: 'Front Office', permissionsSummary: 'Customers, check-in, walk-in, queue' },
  { role: 'TECHNICIAN', email: 'devtest.tech@berts.local', displayName: 'DEVTEST Technician', group: 'Workshop', permissionsSummary: 'Queue view, service-order status' },
  { role: 'PARTS_STAFF', email: 'devtest.parts@berts.local', displayName: 'DEVTEST Parts Staff', group: 'Parts / Transport', permissionsSummary: 'Queue view, parts management' },
  { role: 'TRANSPORT_COORDINATOR', email: 'devtest.transport@berts.local', displayName: 'DEVTEST Transport Coordinator', group: 'Parts / Transport', permissionsSummary: 'Queue view, transport management' },
];

export const DEV_LOGIN_ROLES = DEV_LOGIN_PROFILES.map((p) => p.role);

export function findDevProfile(role: string): DevLoginProfile | undefined {
  return DEV_LOGIN_PROFILES.find((p) => p.role === role);
}
