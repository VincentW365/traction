'use client';

import { useAuth } from '../../hooks/use-auth';
import { Sidebar } from '../../components/sidebar';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
          <span className="text-sm text-slate-500">Loading...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return null;
  }

  return (
    <div className="flex min-h-screen bg-slate-100">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-12 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0">
          <div className="text-xs text-slate-400">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                logout();
                window.location.href = '/login';
              }}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium
                text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Sign out
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
