/**
 * CR-2026-106 — the ONE public base URL for customer-facing links (docs/121 §C4).
 *
 * Root cause it fixes: the API returned relative paths and the web prefixed them
 * with `window.location.origin` — the STAFF PC's own address — so a link handed to
 * a customer pointed at a LAN host or localhost; the booking manage link borrowed
 * the first CORS origin as a stand-in. Every link now comes from `PUBLIC_APP_URL`
 * (validated env), with the first CORS origin only as a local-development fallback.
 *
 * Pure functions over an injected env so they are unit-testable.
 */

export interface PublicUrlEnv {
  PUBLIC_APP_URL?: string | null;
  API_CORS_ORIGIN?: string | null;
}

/** True for hosts a customer's phone could never reach. */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  // RFC 1918 + link-local + CGNAT ranges.
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/** The configured public base, trimmed, without a trailing slash; null when nothing is configured. */
export function resolvePublicAppUrl(env: PublicUrlEnv = process.env as PublicUrlEnv): string | null {
  const explicit = (env.PUBLIC_APP_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const firstCors = (env.API_CORS_ORIGIN ?? '').split(',')[0]?.trim() ?? '';
  return firstCors ? firstCors.replace(/\/+$/, '') : null;
}

/** Absolute customer-facing URL for a path such as `/status/<token>`. */
export function publicUrl(path: string, env: PublicUrlEnv = process.env as PublicUrlEnv): string {
  const base = resolvePublicAppUrl(env) ?? 'http://localhost:3000';
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

/**
 * Production readiness of the configured base: present, absolute https, and not a
 * host only Bert's network can reach. Used by deploy-check and /health.
 */
export function assessPublicAppUrl(env: PublicUrlEnv = process.env as PublicUrlEnv): { ok: boolean; reason: string; value: string | null } {
  const explicit = (env.PUBLIC_APP_URL ?? '').trim();
  if (!explicit) return { ok: false, reason: 'PUBLIC_APP_URL is not set — customer links would fall back to the CORS origin', value: null };
  let u: URL;
  try {
    u = new URL(explicit);
  } catch {
    return { ok: false, reason: 'PUBLIC_APP_URL is not a valid absolute URL', value: explicit };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'PUBLIC_APP_URL must be https:// — customers open these links on phones', value: explicit };
  if (isPrivateOrLocalHost(u.hostname)) return { ok: false, reason: `PUBLIC_APP_URL host "${u.hostname}" is not reachable outside the local network`, value: explicit };
  return { ok: true, reason: 'publicly reachable', value: explicit.replace(/\/+$/, '') };
}
