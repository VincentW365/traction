/**
 * Dev Sandbox Mode (CR-2026-023, E-e) — web-side types + pure helpers.
 *
 * Mirrors the API shapes returned by the gated endpoints:
 *   POST /auth/dev-sandbox/cleanup/preview  → SandboxCleanupPreview
 *   POST /auth/dev-sandbox/cleanup          → SandboxCleanupResult
 *
 * All functions here are pure (no React / DOM) so they can be unit-tested
 * under the app's existing no-DOM vitest setup.
 */

/** The exact phrase the user must type to authorise a sandbox cleanup. */
export const DEV_SANDBOX_CONFIRM = 'CLEAN UP DEV SANDBOX';

export interface SafetyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SandboxSafety {
  pass: boolean;
  checks: SafetyCheck[];
}

/** Response of POST /auth/dev-sandbox/cleanup/preview (read-only). */
export interface SandboxCleanupPreview {
  runId: string;
  label: string | null;
  status: string | null;
  runType: string | null;
  counts: Record<string, number>;
  totalRows: number;
  safety: SandboxSafety;
  confirmationPhrase: string;
}

/** Response of POST /auth/dev-sandbox/cleanup (destructive). */
export interface SandboxCleanupResult {
  runId: string;
  label: string;
  counts: Record<string, number>;
  totalDeleted: number;
  backup: string;
  runType: string | null;
}

/** First 8 chars of a run id, for compact display (e.g. "60a1c1d7"). */
export function shortRunId(runId: string | null | undefined): string {
  return (runId ?? '').slice(0, 8);
}

/**
 * Exact-match gate for the typed confirmation. Deliberately strict (no trim /
 * no case-fold) so the UI only enables the commit button when the text matches
 * EXACTLY what the API requires — the API rejects anything else with 400.
 */
export function isConfirmPhraseValid(input: string): boolean {
  return input === DEV_SANDBOX_CONFIRM;
}

/** True when an API error message indicates dev login is disabled / off. */
export function isDisabledError(message: string | null | undefined): boolean {
  return /disabled/i.test(message ?? '');
}

/**
 * Non-zero delete counts only, sorted by count desc then name, for a compact
 * preview table. A zero-child sandbox session yields an empty array.
 */
export function nonZeroCounts(counts: Record<string, number> | null | undefined): Array<[string, number]> {
  return Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
