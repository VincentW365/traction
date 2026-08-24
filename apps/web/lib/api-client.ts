import {
  clearSession,
  getStoredAccessToken,
  getStoredRefreshToken,
  notifySessionEnded,
  storeTokens,
} from './session';

/**
 * Resolve the API base URL at call time (browser-safe):
 *  1. explicit NEXT_PUBLIC_API_URL (prod / override) — unchanged behavior;
 *  2. in the browser, derive from the current host so a device that loaded the
 *     page over the LAN calls the API on that SAME host:3001 (not its own
 *     localhost) — this is what enables LAN access without baking an IP;
 *  3. SSR / server-side fallback → localhost.
 * Computed per call (not a frozen module-level value) so SSR never freezes it.
 */
function resolveApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001/api/v1`;
  }
  return 'http://localhost:3001/api/v1';
}

let accessToken: string | null = null;

export function setToken(token: string | null) {
  accessToken = token;
}

export function getToken(): string | null {
  return accessToken;
}

/**
 * Carries the HTTP status, so callers can tell "you are not signed in" from "the
 * network dropped". Losing that distinction is what previously turned a momentary
 * blip into a full sign-out.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Parsed error body from the API (e.g. a structured 409 with a `code`). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Endpoints that must never trigger a refresh — refreshing them would loop. */
function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/auth/login') || path.startsWith('/auth/refresh') || path.startsWith('/auth/dev-login');
}

/**
 * One refresh at a time.
 *
 * A screen with six queries open hits six simultaneous 401s the moment the token
 * expires. Without this they would fire six refreshes, five of which race to overwrite
 * each other — and on a rotating refresh token, five of them would be rejected and end
 * the session that the first one just saved.
 */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) return null;

    try {
      const res = await fetch(`${resolveApiBaseUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        // The refresh token itself is expired or rejected. This is the only point at
        // which the session is genuinely over.
        if (res.status === 401 || res.status === 403) {
          clearSession();
          setToken(null);
          notifySessionEnded();
        }
        return null;
      }

      const data = (await res.json()) as {
        accessToken: string;
        refreshToken?: string | null;
      };
      setToken(data.accessToken);
      storeTokens(data.accessToken, data.refreshToken ?? null);
      return data.accessToken;
    } catch {
      // A network failure is not an expired session — leave the tokens alone so the
      // next attempt can succeed once connectivity returns.
      return null;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function send(
  method: string,
  path: string,
  body: unknown,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`${resolveApiBaseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The in-memory token is lost on a full page load, so fall back to the stored one
  // rather than firing the first request of every page unauthenticated.
  if (!accessToken) {
    const stored = getStoredAccessToken();
    if (stored) accessToken = stored;
  }

  let res = await send(method, path, body, accessToken);

  // A 15-minute access token expires while a tab sits idle. Refreshing here means the
  // user never sees it: the request that would have failed simply takes slightly
  // longer. Retried once — a second 401 with a fresh token means genuinely forbidden,
  // not expired.
  if (res.status === 401 && !isAuthEndpoint(path)) {
    const renewed = await refreshAccessToken();
    if (renewed) {
      res = await send(method, path, body, renewed);
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(error.message || `API error: ${res.status}`, res.status, error);
  }

  if (res.status === 204) return {} as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
