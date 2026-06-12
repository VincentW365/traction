'use client';

/**
 * Dev Sandbox Mode banner + cleanup preview/confirm modal (CR-2026-023, E-e).
 *
 * Renders ONLY for dev-login sandbox sessions (the parent passes a runId).
 * The banner is a slim amber strip; "End Session & Clean Up" opens a modal that
 * previews the manifest-scoped delete counts + safety result, requires the user
 * to type the exact confirmation phrase, then commits via the gated API. On
 * success the parent clears the session and redirects to /dev-login. Never logs
 * tokens. UI integration only — all safety lives in the API.
 */
import { useState } from 'react';
import { api } from '../lib/api-client';
import {
  DEV_SANDBOX_CONFIRM,
  shortRunId,
  isConfirmPhraseValid,
  isDisabledError,
  nonZeroCounts,
  type SandboxCleanupPreview,
  type SandboxCleanupResult,
} from '../lib/dev-sandbox';

export function DevSandboxBanner({
  runId,
  role,
  onCleanedUp,
}: {
  runId: string;
  role?: string | null;
  /** Called after a successful cleanup so the parent can sign out + redirect. */
  onCleanedUp: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState<SandboxCleanupPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  async function openModal() {
    setOpen(true);
    setPreview(null);
    setPreviewError(null);
    setDisabled(false);
    setConfirmText('');
    setCleanupError(null);
    setLoadingPreview(true);
    try {
      const res = await api.post<SandboxCleanupPreview>('/auth/dev-sandbox/cleanup/preview');
      setPreview(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Preview failed';
      if (isDisabledError(msg)) setDisabled(true);
      setPreviewError(msg);
    } finally {
      setLoadingPreview(false);
    }
  }

  function closeModal() {
    if (cleaning) return; // don't allow dismiss mid-cleanup
    setOpen(false);
  }

  async function runCleanup() {
    if (!preview?.safety.pass || !isConfirmPhraseValid(confirmText) || cleaning) return;
    setCleaning(true);
    setCleanupError(null);
    try {
      // Destructive — gated + safety-checked server-side. Body is the exact phrase.
      await api.post<SandboxCleanupResult>('/auth/dev-sandbox/cleanup', { confirm: DEV_SANDBOX_CONFIRM });
      onCleanedUp(); // success: parent clears session + redirects
    } catch (e) {
      // Failure: stay signed in, keep tokens, show the error.
      setCleanupError(e instanceof Error ? e.message : 'Cleanup failed');
      setCleaning(false);
    }
  }

  const rows = preview ? nonZeroCounts(preview.counts) : [];
  const safetyPass = !!preview?.safety.pass;
  const canCommit = safetyPass && isConfirmPhraseValid(confirmText) && !cleaning;

  return (
    <>
      {/* Banner strip */}
      <div className="flex items-center justify-between gap-3 bg-amber-50 border-b border-amber-300 px-6 py-1.5 text-amber-900">
        <div className="flex items-center gap-2 min-w-0 text-xs">
          <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          <span className="font-semibold">Dev Sandbox Mode</span>
          {role && <span className="badge bg-amber-100 text-amber-800">{role.replace(/_/g, ' ')}</span>}
          <span className="font-mono text-amber-700">#{shortRunId(runId)}</span>
          <span className="hidden sm:inline text-amber-700">— records you create here can be cleaned up.</span>
        </div>
        <button
          onClick={openModal}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50 transition-colors"
        >
          End Session &amp; Clean Up
        </button>
      </div>

      {/* Preview / confirm modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="card w-full max-w-lg p-5 max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">End Dev Sandbox Session</h3>
              <span className="font-mono text-xs text-slate-400">#{shortRunId(runId)}</span>
            </div>

            {loadingPreview && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <div className="w-4 h-4 border-2 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
                <span className="text-sm text-slate-500">Loading preview…</span>
              </div>
            )}

            {/* Dev login disabled (gate off / production) */}
            {!loadingPreview && disabled && (
              <div className="py-6 text-center">
                <p className="text-sm font-semibold text-slate-900">Dev sandbox cleanup is disabled</p>
                <p className="mt-2 text-xs text-slate-500 max-w-sm mx-auto">
                  This feature is off (or this is production). No changes were made.
                </p>
                <button onClick={closeModal} className="btn-secondary text-xs mt-5">Close</button>
              </div>
            )}

            {/* Non-disabled preview failure */}
            {!loadingPreview && !disabled && previewError && (
              <div className="py-6">
                <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{previewError}</div>
                <div className="flex items-center gap-2 mt-4">
                  <button onClick={openModal} className="btn-secondary text-xs">Retry</button>
                  <button onClick={closeModal} className="btn-secondary text-xs">Close</button>
                </div>
              </div>
            )}

            {/* Preview loaded */}
            {!loadingPreview && !disabled && preview && (
              <div className="mt-4 space-y-4">
                {/* meta */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div className="text-slate-400 uppercase tracking-wide">Run</div>
                  <div className="font-mono text-slate-700 break-all">{preview.runId}</div>
                  {preview.status && (<><div className="text-slate-400 uppercase tracking-wide">Status</div><div className="text-slate-700">{preview.status}</div></>)}
                  {preview.runType && (<><div className="text-slate-400 uppercase tracking-wide">Run type</div><div className="text-slate-700">{preview.runType}</div></>)}
                </div>

                {/* counts */}
                <div>
                  <div className="input-label">Records to remove</div>
                  {rows.length === 0 ? (
                    <p className="text-xs text-slate-500">This session created no removable records (it will be closed with nothing to delete).</p>
                  ) : (
                    <div className="rounded-md border border-slate-200 overflow-hidden">
                      {rows.map(([type, n]) => (
                        <div key={type} className="flex items-center justify-between px-3 py-1.5 text-xs border-b border-slate-100 last:border-b-0">
                          <span className="text-slate-600">{type}</span>
                          <span className="font-semibold text-slate-900 tabular-nums">{n}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-1.5 text-xs font-semibold text-slate-700">
                    <span>Total rows</span>
                    <span className="tabular-nums">{preview.totalRows}</span>
                  </div>
                </div>

                {/* safety */}
                <div>
                  <div className="input-label">Safety</div>
                  {safetyPass ? (
                    <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> PASS — all checks satisfied
                    </p>
                  ) : (
                    <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
                      <p className="text-xs font-semibold text-red-700">FAIL — cleanup is blocked</p>
                      <ul className="mt-1 space-y-0.5">
                        {preview.safety.checks.filter((c) => !c.ok).map((c) => (
                          <li key={c.name} className="text-xs text-red-600">• {c.name} <span className="text-red-400">({c.detail})</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* confirm + commit */}
                {safetyPass && (
                  <div className="pt-1 border-t border-slate-100">
                    <label className="input-label mt-3">
                      Type <span className="font-mono text-amber-700">{preview.confirmationPhrase}</span> to confirm
                    </label>
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      disabled={cleaning}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={DEV_SANDBOX_CONFIRM}
                      className="input-field font-mono"
                    />
                    {cleanupError && (
                      <p className="mt-2 text-xs text-red-600">{cleanupError}</p>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button onClick={closeModal} disabled={cleaning} className="btn-secondary text-xs">Cancel</button>
                  <button onClick={runCleanup} disabled={!canCommit} className="btn-danger text-xs">
                    {cleaning ? 'Cleaning up…' : 'Clean Up & Sign Out'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
