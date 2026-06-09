'use client';

import Link from 'next/link';
import { useAuth } from '../../hooks/use-auth';
import { PageHeader } from '../../components/ui/page-header';

const QUICK_ACTIONS = [
  { href: '/check-in', label: 'Check-In', description: 'Process arrivals and walk-ins', iconColor: 'bg-blue-500', icon: <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
  { href: '/queue', label: 'Queue Board', description: 'Live queue and service status', iconColor: 'bg-emerald-500', icon: <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg> },
  { href: '/dispatch', label: 'Dispatch', description: 'Bay and resource assignment', iconColor: 'bg-amber-500', icon: <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg> },
  { href: '/schedule', label: 'Schedule', description: "Today's appointments and timeline", iconColor: 'bg-indigo-500', icon: <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg> },
  { href: '/appointments', label: 'Appointments', description: 'Browse and manage bookings', iconColor: 'bg-violet-500', icon: <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
  { href: '/customers', label: 'Customers', description: 'Search and manage customers', iconColor: 'bg-slate-500', icon: <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
];

export default function DashboardHomePage() {
  const { user } = useAuth();

  return (
    <div className="page-container">
      <PageHeader
        title={`Welcome back, ${user?.fullName?.split(' ')[0] ?? 'there'}`}
        subtitle="Traction — Service Operations"
        breadcrumbs={[{ label: 'Dashboard' }]}
      />

      <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Quick Actions</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="card group p-4 hover:border-slate-300 hover:shadow-md transition-all"
          >
            <div className="flex items-start gap-3">
              <div className={`rounded-lg p-2 ${action.iconColor} shrink-0`}>
                {action.icon}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">
                  {action.label}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{action.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
