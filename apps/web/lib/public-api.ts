/**
 * CR-2026-105c — fetch helper for PUBLIC pages (booking, manage link). No bearer
 * token, no session storage, tolerant of the free-tier API cold start: the first
 * request may take a while, so callers can show a "waking up" state and retry.
 */

export function resolvePublicApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001/api/v1`;
  }
  return 'http://localhost:3001/api/v1';
}

export class PublicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${resolvePublicApiBaseUrl()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // CR-2026-108 Stage 3 — carries the HttpOnly UAT session cookie once one has
    // been exchanged. It is the only cookie this API sets, the page can never read
    // it, and for an ordinary customer there is simply nothing to send.
    credentials: 'include',
  });
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* no body */
    }
    const p = parsed as { message?: unknown; code?: string } | null;
    const message = Array.isArray(p?.message) ? p!.message.join(' ') : typeof p?.message === 'string' ? p.message : `Request failed (${res.status})`;
    throw new PublicApiError(message, res.status, p?.code, parsed);
  }
  return res.json() as Promise<T>;
}

export const publicApi = {
  get: <T>(path: string) => send<T>('GET', path),
  post: <T>(path: string, body?: unknown) => send<T>('POST', path, body),
};

/** "Fri 11 Sep, 2:40 PM" in the site's zone. */
export function fmtWhen(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleString('en-US', timeZone ? { ...opts, timeZone } : opts);
  } catch {
    return d.toLocaleString('en-US', opts);
  }
}

export function fmtTimeOnly(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleTimeString('en-US', timeZone ? { ...opts, timeZone } : opts);
  } catch {
    return d.toLocaleTimeString('en-US', opts);
  }
}

export function fmtDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
