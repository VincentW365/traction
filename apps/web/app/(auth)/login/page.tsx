'use client';

import { useState, FormEvent } from 'react';
import { useAuth } from '../../../hooks/use-auth';

export default function LoginPage() {
  const { user, loading, error, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  if (user && !loading) {
    window.location.href = '/check-in';
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    await login(email, password);
    setSubmitting(false);
  }

  return (
    <main className="min-h-screen flex">
      {/* ─── Left: Branded Hero Panel ─── */}
      <div className="hidden lg:flex lg:w-[55%] relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #0f1c2e 0%, #1b3a5c 50%, #1e3a5f 100%)' }}>
        {/* Subtle tire tread pattern — top-right */}
        <svg className="absolute -top-20 -right-20 w-[500px] h-[500px] opacity-[0.04]" viewBox="0 0 400 400" fill="none">
          {Array.from({ length: 12 }).map((_, i) => (
            <rect key={i} x="180" y={i * 33} width="40" height="20" rx="4" fill="white" transform={`rotate(${i * 3} 200 200)`} />
          ))}
          <circle cx="200" cy="200" r="150" stroke="white" strokeWidth="3" fill="none" />
          <circle cx="200" cy="200" r="180" stroke="white" strokeWidth="1.5" fill="none" />
          <circle cx="200" cy="200" r="100" stroke="white" strokeWidth="2" fill="none" />
        </svg>

        {/* Subtle diagonal lines — bottom-left */}
        <svg className="absolute -bottom-10 -left-10 w-[400px] h-[400px] opacity-[0.03]" viewBox="0 0 400 400">
          {Array.from({ length: 8 }).map((_, i) => (
            <line key={i} x1={0} y1={i * 55} x2={400} y2={i * 55 + 200} stroke="white" strokeWidth="2" />
          ))}
        </svg>

        {/* Gold accent line — top */}
        <div className="absolute top-0 left-0 right-0 h-1" style={{ background: 'linear-gradient(90deg, transparent, #EAB308, transparent)' }} />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-center px-16 xl:px-20 w-full">
          {/* Logo — hero size, placed on a softened panel so it blends with the dark bg */}
          <div className="mb-12">
            <div className="inline-block rounded-2xl bg-gradient-to-br from-slate-800/80 to-slate-900/60 p-6 xl:p-8 shadow-2xl shadow-black/30 ring-1 ring-white/10">
              <img
                src="/logo.png"
                alt="Bert's Auto Parts — Traction"
                className="w-[280px] xl:w-[320px] h-auto object-contain"
                style={{ filter: 'brightness(1.08) contrast(1.05)' }}
              />
            </div>
          </div>

          {/* Tagline */}
          <div className="max-w-md">
            <h2 className="text-white text-xl xl:text-2xl font-semibold leading-snug mb-4">
              Your vehicle service,<br />
              <span style={{ color: '#EAB308' }}>organized and transparent.</span>
            </h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Manage appointments, track repairs, view estimates, and stay
              updated on your vehicle&apos;s service progress — all in one place.
            </p>
          </div>

          {/* Trust indicators */}
          <div className="mt-12 flex items-center gap-8">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div>
                <p className="text-white text-xs font-medium">Trusted Service</p>
                <p className="text-slate-500 text-[10px]">Quality guaranteed</p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="text-white text-xs font-medium">Real-Time Updates</p>
                <p className="text-slate-500 text-[10px]">Track your vehicle live</p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center">
                <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <p className="text-white text-xs font-medium">Easy Scheduling</p>
                <p className="text-slate-500 text-[10px]">Book appointments online</p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="absolute bottom-0 left-0 right-0 px-16 py-4">
          <p className="text-slate-600 text-[10px]">&copy; {new Date().getFullYear()} Bert&apos;s Auto Parts Service Centre. All rights reserved.</p>
        </div>
      </div>

      {/* ─── Right: Login Form ─── */}
      <div className="flex-1 flex items-center justify-center bg-slate-50 px-6 py-12 lg:px-16">
        <div className="w-full max-w-sm">
          {/* Mobile logo — shown on small screens only */}
          <div className="lg:hidden flex justify-center mb-10">
            <img
              src="/logo.png"
              alt="Bert's Auto Parts — Traction"
              className="w-64 h-auto object-contain"
            />
          </div>

          {/* Welcome */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-slate-900">Welcome back</h1>
            <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
              Sign in to manage appointments, track service progress, and keep your vehicles running smoothly.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900
                  placeholder:text-slate-400 shadow-sm
                  focus:border-yellow-500 focus:ring-2 focus:ring-yellow-500/20 focus:outline-none
                  transition-all"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900
                  placeholder:text-slate-400 shadow-sm
                  focus:border-yellow-500 focus:ring-2 focus:ring-yellow-500/20 focus:outline-none
                  transition-all"
                placeholder="Enter your password"
              />
            </div>

            {/* Remember me + Forgot password */}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-yellow-500 focus:ring-yellow-500/30"
                />
                <span className="text-sm text-slate-600">Remember me</span>
              </label>
              <button type="button" className="text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors">
                Forgot password?
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm
                disabled:opacity-50 disabled:cursor-not-allowed transition-all
                hover:shadow-md active:scale-[0.99]"
              style={{
                background: submitting ? '#94a3b8' : 'linear-gradient(135deg, #EAB308, #F59E0B)',
              }}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in...
                </span>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          {/* Help link */}
          <div className="mt-8 text-center">
            <p className="text-xs text-slate-400">
              Need help?{' '}
              <button type="button" className="text-slate-600 font-medium hover:text-slate-900 transition-colors">
                Contact support
              </button>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
