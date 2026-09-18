'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../hooks/use-auth';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  roles?: string[];
  section?: string;
}

const ICON_CLASS = 'w-4 h-4';

// The business has one management label: Manager. ADMIN is a role CODE and must
// never surface as a word a user reads.
const ROLE_DISPLAY: Record<string, string> = {
  ADMIN: 'Manager',
  SERVICE_ADVISOR: 'Service Advisor',
  TECHNICIAN: 'Technician',
};

const NAV_ITEMS: NavItem[] = [
  {
    href: '/check-in', label: 'Check-In', section: 'Operations',
    roles: ['ADMIN', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  },
  {
    href: '/queue', label: 'Queue Board', section: 'Operations',
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>,
  },
  {
    href: '/dispatch', label: 'Dispatch', section: 'Operations',
    roles: ['ADMIN', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>,
  },
  {
    href: '/schedule', label: 'Schedule', section: 'Operations',
    roles: ['ADMIN', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  },
  {
    href: '/inspections', label: 'Inspections', section: 'Operations',
    roles: ['ADMIN', 'SERVICE_ADVISOR', 'TECHNICIAN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>,
  },
  {
    href: '/appointments', label: 'Appointments', section: 'Bookings',
    roles: ['ADMIN', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  },
  {
    href: '/customers', label: 'Customers', section: 'Bookings',
    roles: ['ADMIN', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    href: '/complaints', label: 'Complaints', section: 'Bookings',
    roles: ['ADMIN', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>,
  },
  {
    href: '/technician', label: 'My Jobs', section: 'Technician',
    roles: ['TECHNICIAN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    href: '/admin/dashboard', label: 'Control Center', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /></svg>,
  },
  {
    href: '/reports', label: 'Reports', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>,
  },
  {
    href: '/reports/service-mix', label: 'Service Mix', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.488 9A9.004 9.004 0 0015 3.512V9h5.488z" /></svg>,
  },
  {
    href: '/reports/technician-kpi', label: 'Technician KPI', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.488 9A9.004 9.004 0 0015 3.512V9h5.488z" /></svg>,
  },
  // Benchmark Review deliberately has no nav entry. Since CR-2026-092 every service
  // carries a contribution policy before it can be booked, so the held-jobs queue
  // should stay empty for good — the page still exists at /reports/benchmark-review
  // as a safety net, and the KPI dashboard shows an amber banner linking to it the
  // moment anything is actually held. An always-visible menu item for an always-empty
  // queue would only teach people to ignore it.
  {
    href: '/reports/shared-jobs', label: 'Shared Jobs', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    // CR-2026-105c — self-service vs staff bookings, no-shows, utilisation, ETA accuracy.
    href: '/reports/appointments', label: 'Appointments Report', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  },
  {
    href: '/reports/due-for-contact', label: 'Due for Contact', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>,
  },
  {
    href: '/admin/deployment', label: 'Deployment', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" /></svg>,
  },
  {
    href: '/admin/settings', label: 'Settings', section: 'Management',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>,
  },
  // Admin section
  {
    href: '/admin/staff', label: 'Staff', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>,
  },
  {
    href: '/admin/availability', label: 'Availability', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  },
  {
    href: '/admin/performance', label: 'Performance', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>,
  },
  {
    href: '/admin/assignments', label: 'Assignments', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    href: '/admin/service-catalogue', label: 'Services', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>,
  },
  {
    href: '/admin/kpi-mapping', label: 'KPI Mapping', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2zM10 7h4a3 3 0 013 3v4" /></svg>,
  },
  {
    href: '/admin/resources', label: 'Resources & Bays', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>,
  },
  {
    // CR-2026-108 — why a customer is or is not offered a time, and what the
    // resource-aware model would have said instead. Reachable from the menu
    // because a diagnostic nobody can find gets used once and then forgotten.
    href: '/admin/booking-simulator', label: 'Booking Simulator', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /></svg>,
  },
  {
    // CR-2026-096 — customer message templates, editable without redeployment.
    href: '/admin/notifications', label: 'Notifications', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>,
  },
  // Integrations deliberately has no entry (CR-2026-095): the platform runs
  // standalone, and the page behind this link was a placeholder advertising
  // synchronisation that never existed.
  {
    // CR-2026-099 — reconciliation of historical unknown-customer visits.
    href: '/admin/data-review', label: 'Data Review', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16l2.879-2.879m0 0a3 3 0 104.243-4.242 3 3 0 00-4.243 4.242zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  },
  {
    href: '/admin/audit-logs', label: 'Audit Logs', section: 'Setup',
    roles: ['ADMIN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, sandboxRunId, sandboxRole } = useAuth();
  const userRole = user?.roleCode ?? '';
  // CR-2026-047 — dev sandbox sessions see every feature (the effective role is
  // already ADMIN, but some nav is role-exclusive of admin, e.g. technician "My Work").
  const fullAccess = !!sandboxRunId;

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (fullAccess || !item.roles) return true;
    return item.roles.includes(userRole);
  });

  // Group items by section
  const sections = new Map<string, NavItem[]>();
  for (const item of visibleItems) {
    const section = item.section ?? 'Other';
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(item);
  }

  return (
    <aside className="w-60 bg-slate-900 flex flex-col shrink-0 print:hidden">
      {/* Brand */}
      <div className="px-3 py-3 border-b border-slate-800">
        <Link href="/" className="block">
          <img
            src="/brand-mark.png"
            alt="Bert's Auto Parts"
            className="h-9 w-auto object-contain"
          />
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 overflow-y-auto">
        {Array.from(sections.entries()).map(([section, items], idx) => (
          <div key={section} className={idx > 0 ? 'mt-5' : ''}>
            <div className="px-3 mb-1.5">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
                {section}
              </span>
            </div>
            {items.map((item) => {
              const active = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition-all mb-0.5 ${
                    active
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <span className={active ? 'text-white' : 'text-slate-500'}>{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User footer */}
      {user && (
        <div className="px-4 py-3 border-t border-slate-800">
          <div className="text-xs font-medium text-slate-300 truncate">{user.fullName}</div>
          <div className="text-[10px] text-slate-500 capitalize">
            {ROLE_DISPLAY[sandboxRole ?? user.roleCode] ?? (sandboxRole ?? user.roleCode).replace(/_/g, ' ').toLowerCase()}
            {fullAccess && <span className="text-amber-400 normal-case"> · full access</span>}
          </div>
          {/* CR-2026-094 — which commit this build came from, for managers only. Blank
              in local dev (no stamp) rather than showing a stale or invented value. */}
          {user.roleCode === 'ADMIN' && process.env.NEXT_PUBLIC_BUILD_COMMIT && (
            <div className="text-[10px] text-slate-600 font-mono mt-1">
              Build: {process.env.NEXT_PUBLIC_BUILD_COMMIT.slice(0, 7)}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
