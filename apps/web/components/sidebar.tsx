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

const NAV_ITEMS: NavItem[] = [
  {
    href: '/check-in', label: 'Check-In', section: 'Operations',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  },
  {
    href: '/queue', label: 'Queue Board', section: 'Operations',
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>,
  },
  {
    href: '/dispatch', label: 'Dispatch', section: 'Operations',
    roles: ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'FRONT_DESK'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>,
  },
  {
    href: '/schedule', label: 'Schedule', section: 'Operations',
    roles: ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  },
  {
    href: '/inspections', label: 'Inspections', section: 'Operations',
    roles: ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'TECHNICIAN', 'FRONT_DESK'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>,
  },
  {
    href: '/appointments', label: 'Appointments', section: 'Bookings',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  },
  {
    href: '/customers', label: 'Customers', section: 'Bookings',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    href: '/complaints', label: 'Complaints', section: 'Bookings',
    roles: ['ADMIN', 'MANAGER', 'FRONT_DESK', 'SERVICE_ADVISOR'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>,
  },
  {
    href: '/technician', label: 'My Work', section: 'Technician',
    roles: ['TECHNICIAN'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    href: '/admin/dashboard', label: 'Control Center', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /></svg>,
  },
  {
    href: '/reports', label: 'Reports', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>,
  },
  {
    href: '/reports/historical', label: 'Historical Analytics', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3v18h18M7 16l4-4 3 3 5-6" /></svg>,
  },
  {
    href: '/reports/service-mix', label: 'Service Mix', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.488 9A9.004 9.004 0 0015 3.512V9h5.488z" /></svg>,
  },
  {
    href: '/reports/due-for-contact', label: 'Due for Contact', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>,
  },
  {
    href: '/reports/rework', label: 'Rework / FTF', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
  },
  {
    href: '/admin/settings', label: 'Settings', section: 'Management',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>,
  },
  // Admin section
  {
    href: '/admin/staff', label: 'Staff', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>,
  },
  {
    href: '/admin/availability', label: 'Availability', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
  },
  {
    href: '/admin/performance', label: 'Performance', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>,
  },
  {
    href: '/admin/assignments', label: 'Assignments', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  },
  {
    href: '/admin/service-catalogue', label: 'Services', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>,
  },
  {
    href: '/admin/resources', label: 'Resources', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>,
  },
  {
    href: '/admin/integrations', label: 'Integrations', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>,
  },
  {
    href: '/admin/audit-logs', label: 'Audit Logs', section: 'Admin',
    roles: ['ADMIN', 'MANAGER'],
    icon: <svg className={ICON_CLASS} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const userRole = user?.roleCode ?? '';

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!item.roles) return true;
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
    <aside className="w-60 bg-slate-900 flex flex-col shrink-0">
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
          <div className="text-[10px] text-slate-500 capitalize">{user.roleCode.replace(/_/g, ' ').toLowerCase()}</div>
        </div>
      )}
    </aside>
  );
}
