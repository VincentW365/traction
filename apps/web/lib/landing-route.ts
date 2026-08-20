/**
 * CR-2026-084 — where a user lands after signing in.
 *
 * Both sign-in pages used to hard-code `/check-in` for every role. A technician
 * therefore landed on the front desk's screen, which has no role guard, so it
 * rendered in full and then failed every API call it made — customer search,
 * today's appointments, check-in and walk-in are all permissions a technician
 * does not hold. Their first impression of the app was a dead page, with their
 * own work reachable only by spotting "My Work" in the sidebar.
 */
export function landingRouteForRole(roleCode: string | null | undefined): string {
  switch (roleCode) {
    case 'TECHNICIAN':
      return '/technician';
    case 'ADMIN':
      return '/admin/dashboard';
    case 'SERVICE_ADVISOR':
    default:
      return '/check-in';
  }
}
