'use client';

/**
 * CR-2026-106 — Admin → Deployment → "Prove outbound email works".
 *
 * Root cause it answers (docs/121 §C3): the screen said "Email Sent" while the
 * SMTP path had never delivered a message. This card asks the API to verify the
 * transport (connection + login) AND send a real test message to an address the
 * manager types, then shows the mail server's own answer — accepted/rejected
 * recipients and the response line — so "it works" is proven, not assumed.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api-client';

interface VerifyResponse {
  verified: boolean;
  configured: boolean;
  mode: 'TEST' | 'LIVE';
  transport: { host: string; port: number; secure: boolean; from: string; user: string | null } | null;
  transportCheck: { ok: boolean; detail: string };
  send: {
    logId: string;
    to: string;
    success: boolean;
    providerReference: string | null;
    accepted: string[];
    rejected: string[];
    response: string | null;
    failureReason: string | null;
  } | null;
}

export function EmailVerificationCard() {
  const [to, setTo] = useState('');
  const verify = useMutation<VerifyResponse, Error, string>({
    mutationFn: (address) => api.post<VerifyResponse>('/notifications/verify', { to: address }),
  });
  const r = verify.data;

  return (
    <div className="card p-4" data-testid="email-verification-card">
      <h2 className="text-sm font-semibold text-slate-900 mb-1">Prove outbound email works</h2>
      <p className="text-xs text-slate-500 mb-3">
        Checks the mail server login, then sends one real test message to the address below and shows the server&apos;s own reply.
        Nothing here is redirected — the message goes exactly where you type.
      </p>
      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (to.trim()) verify.mutate(to.trim());
        }}
      >
        <input
          type="email"
          required
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="your.name@example.com"
          className="input-field flex-1 text-sm"
          aria-label="Send the test email to"
        />
        <button type="submit" disabled={verify.isPending || !to.trim()} className="btn-primary text-sm min-h-11">
          {verify.isPending ? 'Sending test…' : 'Send test email'}
        </button>
      </form>

      {verify.isError && <p className="mt-3 text-xs text-red-700">{verify.error.message}</p>}

      {r && (
        <div className="mt-3 space-y-1.5 text-xs" data-testid="email-verification-result">
          <p className={`font-semibold ${r.verified ? 'text-emerald-700' : 'text-red-700'}`}>
            {r.verified ? 'PASS — the mail server accepted the test message' : 'FAIL — outbound email is not working yet'}
          </p>
          {!r.configured && (
            <p className="text-red-700">EMAIL_PROVIDER is &quot;stub&quot; on this deployment. Set EMAIL_PROVIDER=smtp and the SMTP_* variables, then redeploy.</p>
          )}
          {r.transport && (
            <p className="text-slate-600">
              Transport: {r.transport.host}:{r.transport.port} ({r.transport.secure ? 'TLS' : 'STARTTLS'}) · from {r.transport.from}
              {r.transport.user ? ` · login ${r.transport.user}` : ' · no login'}
            </p>
          )}
          <p className={r.transportCheck.ok ? 'text-emerald-700' : 'text-red-700'}>
            Connection &amp; login: {r.transportCheck.ok ? 'OK' : 'FAILED'} — {r.transportCheck.detail}
          </p>
          {r.send && (
            <>
              <p className={r.send.success ? 'text-emerald-700' : 'text-red-700'}>
                Test send to {r.send.to}: {r.send.success ? 'accepted' : 'FAILED'}
                {r.send.failureReason ? ` — ${r.send.failureReason}` : ''}
              </p>
              {(r.send.accepted.length > 0 || r.send.rejected.length > 0 || r.send.response) && (
                <p className="text-slate-500 break-all">
                  {r.send.accepted.length > 0 && `accepted: ${r.send.accepted.join(', ')} `}
                  {r.send.rejected.length > 0 && `rejected: ${r.send.rejected.join(', ')} `}
                  {r.send.response && `server said: ${r.send.response}`}
                </p>
              )}
              <p className="text-slate-500">Recorded in notification history (system · smtp_verification). Mode: {r.mode}.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
