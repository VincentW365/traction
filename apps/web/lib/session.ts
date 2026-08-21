/**
 * Where the signed-in session lives.
 *
 * Owned here rather than in the auth hook because the API client also needs it: when a
 * 15-minute access token expires, the client refreshes it without the UI being involved,
 * and both sides have to agree on where the tokens are kept. Two copies of these key
 * names is how a refresh silently writes a token nothing else reads.
 *
 * sessionStorage, not localStorage: a shared front-desk machine should not keep somebody
 * signed in after the tab closes.
 */

const TOKEN_KEY = 'bsop_token';
const REFRESH_KEY = 'bsop_refresh';
const SANDBOX_RUN_KEY = 'bsop_sandbox_run_id';
const SANDBOX_ROLE_KEY = 'bsop_sandbox_role';

const isBrowser = () => typeof window !== 'undefined';

export function getStoredAccessToken(): string | null {
  return isBrowser() ? sessionStorage.getItem(TOKEN_KEY) : null;
}

export function getStoredRefreshToken(): string | null {
  return isBrowser() ? sessionStorage.getItem(REFRESH_KEY) : null;
}

export function storeTokens(accessToken: string, refreshToken?: string | null): void {
  if (!isBrowser()) return;
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  // A refresh response may or may not rotate the refresh token. Overwriting with
  // undefined would sign the user out at the next expiry.
  if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearSession(): void {
  if (!isBrowser()) return;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(SANDBOX_RUN_KEY);
  sessionStorage.removeItem(SANDBOX_ROLE_KEY);
}

export function getSandboxMarkers(): { runId: string | null; role: string | null } {
  if (!isBrowser()) return { runId: null, role: null };
  return {
    runId: sessionStorage.getItem(SANDBOX_RUN_KEY),
    role: sessionStorage.getItem(SANDBOX_ROLE_KEY),
  };
}

export function storeSandboxMarkers(runId: string, role: string): void {
  if (!isBrowser()) return;
  sessionStorage.setItem(SANDBOX_RUN_KEY, runId);
  sessionStorage.setItem(SANDBOX_ROLE_KEY, role);
}

export function clearSandboxMarkers(): void {
  if (!isBrowser()) return;
  sessionStorage.removeItem(SANDBOX_RUN_KEY);
  sessionStorage.removeItem(SANDBOX_ROLE_KEY);
}

/**
 * Notified when the session is genuinely over — the refresh token was rejected or has
 * expired — so the UI can show the login screen instead of a page of failed requests.
 *
 * A callback rather than a direct import so the API client never depends on React.
 */
type SessionEndedListener = () => void;
const listeners = new Set<SessionEndedListener>();

export function onSessionEnded(fn: SessionEndedListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifySessionEnded(): void {
  for (const fn of [...listeners]) fn();
}
