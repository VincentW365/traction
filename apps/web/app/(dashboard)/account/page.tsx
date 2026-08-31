'use client';

/**
 * CR-2026-099 — Account: self-service password change.
 *
 * Verifies the current password server-side, enforces the policy, and rotates
 * this session's tokens so the user stays signed in while every OTHER session
 * from before the change is ended.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { storeTokens } from '../../../lib/session';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';

export default function AccountPage() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && newPassword !== confirm;

  const change = useMutation<{ accessToken: string; refreshToken: string }, unknown, void>({
    mutationFn: () => api.post('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: (tokens) => {
      // Keep THIS session alive on the post-change tokens.
      storeTokens(tokens.accessToken, tokens.refreshToken);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setDone(true);
    },
  });

  return (
    <div className="page-container max-w-lg">
      <PageHeader
        title="Account"
        subtitle={user ? `${user.fullName ?? ''}` : ''}
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Account' }]}
      />

      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Change Password</h2>
        </div>
        <div className="card-body space-y-3">
          {done && (
            <p className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
              Password changed. Other devices signed in before the change will be asked to sign in again.
            </p>
          )}
          <div>
            <label className="input-label">Current password</label>
            <input type="password" value={currentPassword} onChange={(e) => { setCurrentPassword(e.target.value); setDone(false); }} className="input-field" autoComplete="current-password" />
          </div>
          <div>
            <label className="input-label">New password</label>
            <input type="password" value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setDone(false); }} className="input-field" autoComplete="new-password" />
            <p className="text-[11px] text-slate-400 mt-1">At least 8 characters, with a letter and a number.</p>
          </div>
          <div>
            <label className="input-label">Confirm new password</label>
            <input type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setDone(false); }} className="input-field" autoComplete="new-password" />
            {mismatch && <p className="text-xs text-red-600 mt-1">Passwords do not match.</p>}
          </div>
          {change.isError && (
            <p className="text-xs text-red-600">
              {change.error instanceof Error ? change.error.message : 'Could not change the password.'}
            </p>
          )}
          <button
            onClick={() => change.mutate()}
            disabled={change.isPending || !currentPassword || !newPassword || newPassword !== confirm}
            className="btn-primary text-sm"
          >
            {change.isPending ? 'Changing…' : 'Change Password'}
          </button>
        </div>
      </div>
    </div>
  );
}
