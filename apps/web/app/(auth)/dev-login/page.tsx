'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../hooks/use-auth';

interface DevProfile {
  role: string;
  email: string;
  displayName: string;
  group: string;
  permissionsSummary: string;
  available: boolean;
}
interface ProfilesResponse {
  enabled: boolean;
  warning: string;
  profiles: DevProfile[];
}

const GROUP_ORDER = ['Administration', 'Front Office', 'Workshop'];

export default function DevLoginPage() {
  const { user, loading, error, devLogin } = useAuth();
  const [data, setData] = useState<ProfilesResponse | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [signingRole, setSigningRole] = useState<string | null>(null);
  // CR-2026-023 — success notice after a dev sandbox session was cleaned up.
  const [justCleaned, setJustCleaned] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('cleaned') === '1') {
      setJustCleaned(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api
      .get<ProfilesResponse>('/auth/dev-login/profiles')
      .then((res) => { if (active) { setData(res); setLoadingProfiles(false); } })
      .catch(() => { if (active) { setDisabled(true); setLoadingProfiles(false); } }); // 403 = gate off / production
    return () => { active = false; };
  }, []);

  // Already signed in (or just signed in) → into the app.
  if (user && !loading) {
    if (typeof window !== 'undefined') window.location.href = '/check-in';
    return null;
  }

  async function handlePick(role: string) {
    setSigningRole(role);
    await devLogin(role);
    setSigningRole(null);
  }

  const grouped = (data?.profiles ?? []).reduce<Record<string, DevProfile[]>>((acc, p) => {
    (acc[p.group] ??= []).push(p);
    return acc;
  }, {});

  return (
    <main className="min-h-screen bg-slate-100">
      {/* Branded header */}
      <div className="relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #0f1c2e 0%, #1b3a5c 60%, #1e3a5f 100%)' }}>
        <div className="absolute top-0 left-0 right-0 h-1" style={{ background: 'linear-gradient(90deg, transparent, #EAB308, transparent)' }} />
        <div className="max-w-5xl mx-auto px-6 py-10">
          <p className="text-xs font-semibold tracking-widest text-yellow-400 uppercase">Bert&apos;s Service Operations</p>
          <h1 className="mt-1 text-2xl font-bold text-white">Developer / Test Login</h1>
          <p className="mt-1 text-sm text-slate-300">One-click sign-in as any role for local/staging testing.</p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* CR-2026-023 — sandbox cleanup success notice */}
        {justCleaned && (
          <div className="mb-6 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 flex items-center gap-3">
            <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            <p className="text-sm font-medium text-emerald-800">Dev sandbox session ended and its records were cleaned up. You can sign in again below.</p>
          </div>
        )}

        {/* Warning banner */}
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-center gap-3">
          <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86l-8.48 14.7A1 1 0 002.69 20h18.62a1 1 0 00.87-1.5l-8.48-14.7a1 1 0 00-1.74 0z" /></svg>
          <p className="text-sm font-medium text-amber-800">Development/Test Login Only — Disabled in Production.</p>
        </div>

        {error && (
          <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {loadingProfiles && <p className="text-sm text-slate-500">Loading profiles…</p>}

        {!loadingProfiles && disabled && (
          <div className="card">
            <div className="card-body text-center py-10">
              <h2 className="text-base font-semibold text-slate-900">Dev login is disabled</h2>
              <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
                This feature is off. To enable it on a local/staging server, set <span className="font-mono">ALLOW_DEV_LOGIN=true</span> with <span className="font-mono">NODE_ENV</span> not <span className="font-mono">production</span>, then restart the API.
              </p>
              <a href="/login" className="btn-secondary mt-6 inline-flex">Go to normal login</a>
            </div>
          </div>
        )}

        {!loadingProfiles && !disabled && data && (
          <div className="space-y-8">
            {GROUP_ORDER.filter((g) => grouped[g]?.length).map((group) => (
              <section key={group}>
                <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase mb-3">{group}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {grouped[group].map((p) => (
                    <div key={p.role} className={`card ${p.available ? '' : 'opacity-60'}`}>
                      <div className="card-body">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-slate-900">{p.role.replace(/_/g, ' ')}</span>
                          {!p.available && <span className="badge bg-slate-100 text-slate-500">Unavailable</span>}
                        </div>
                        <p className="mt-1 text-sm text-slate-700">{p.displayName}</p>
                        <p className="text-xs text-slate-400 font-mono break-all">{p.email}</p>
                        <p className="mt-2 text-xs text-slate-500">{p.permissionsSummary}</p>
                        <button
                          onClick={() => handlePick(p.role)}
                          disabled={!p.available || signingRole !== null}
                          className="btn-primary w-full mt-4 disabled:opacity-50"
                        >
                          {signingRole === p.role ? 'Signing in…' : `Sign in as ${p.role.replace(/_/g, ' ')}`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            <p className="text-xs text-slate-400">
              Unavailable cards need their DEVTEST user seeded — run <span className="font-mono">scripts/seed-dev-users.ts --commit</span> (gate enabled).
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
