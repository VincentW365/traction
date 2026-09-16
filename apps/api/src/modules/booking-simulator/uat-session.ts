/**
 * CR-2026-108 Stage 3 — the UAT booking session, as a LAUNCH/EXCHANGE pair.
 *
 * THE PROBLEM IT SOLVES
 * Stage 1 suppresses notifications per record, by resolving `testDataRunId` from
 * the customer / vehicle / visit a message is about. That covers a RETURNING test
 * customer perfectly — and not at all the case we most need to test: a genuinely
 * brand-new customer coming through /book for the first time. Such a customer has
 * no anchor to resolve, so their records look real and their confirmation is sent.
 *
 * WHY TWO TOKENS
 * The launch token is a privileged capability: it makes bookings disposable and
 * silences customer notifications. A capability like that must not live in an
 * address bar, where it is copied into browser history, referrers, bookmarks,
 * screenshots and shoulder-surfing range, and stays valid for anyone who finds it.
 *
 * So it is redeemed ONCE, immediately, and exchanged for a session the browser
 * cannot read:
 *
 *   launch token (single use, <= 30 min, in the URL for one request only)
 *     -> POST /public/booking/uat/redeem
 *     -> session cookie (HttpOnly, Secure in production, bounded lifetime)
 *     -> the URL is cleaned; the rest of the booking uses the cookie
 *
 * Single use is enforced by recording the token's `jti` in the audit log at
 * redemption, so a replay is refused even across a restart — and the redemption
 * is auditable evidence in its own right, which a fingerprint in memory is not.
 */
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

export const UAT_LAUNCH_KIND = 'uat-booking-launch';
export const UAT_SESSION_KIND = 'uat-booking-session';

/** How long a launch link stays redeemable. */
export const UAT_LAUNCH_TTL_MINUTES = 30;
/** How long the exchanged session lasts — long enough to finish a booking. */
export const UAT_SESSION_TTL_MINUTES = 60;

/** The cookie the exchanged session lives in. HttpOnly: JS never sees it. */
export const UAT_COOKIE_NAME = 'bsop_uat';

export interface UatContext {
  testDataRunId: string;
  runLabel: string;
  issuedByUserId: string;
}

export interface UatLaunchClaims extends UatContext {
  kind: typeof UAT_LAUNCH_KIND;
  /** Unique per launch token; the handle single-use redemption is recorded under. */
  jti: string;
}

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not configured');
  return s;
}

// ---------------------------------------------------------------------------
// Launch token — minted by the simulator, redeemed once
// ---------------------------------------------------------------------------

export function signUatLaunchToken(ctx: UatContext): { token: string; jti: string; expiresAt: Date } {
  const jti = randomUUID();
  const token = jwt.sign({ ...ctx, kind: UAT_LAUNCH_KIND, jti }, secret(), {
    expiresIn: `${UAT_LAUNCH_TTL_MINUTES}m`,
  });
  return { token, jti, expiresAt: new Date(Date.now() + UAT_LAUNCH_TTL_MINUTES * 60_000) };
}

/**
 * Why a launch token could not be redeemed. The caller turns this into ONE
 * customer-safe message — the distinctions exist for logs and tests, never for
 * the page, which must not become an oracle for token validity.
 */
export type UatLaunchRejection = 'MISSING' | 'MALFORMED' | 'EXPIRED' | 'WRONG_KIND' | 'INCOMPLETE';

export function verifyUatLaunchToken(
  token: string | null | undefined,
): { ok: true; claims: UatLaunchClaims } | { ok: false; reason: UatLaunchRejection } {
  if (!token) return { ok: false, reason: 'MISSING' };
  let decoded: Partial<UatLaunchClaims> & { name?: string };
  try {
    decoded = jwt.verify(token, secret()) as Partial<UatLaunchClaims>;
  } catch (e: unknown) {
    const name = (e as { name?: string })?.name;
    return { ok: false, reason: name === 'TokenExpiredError' ? 'EXPIRED' : 'MALFORMED' };
  }
  if (decoded.kind !== UAT_LAUNCH_KIND) return { ok: false, reason: 'WRONG_KIND' };
  if (!decoded.jti || !decoded.testDataRunId || !decoded.runLabel || !decoded.issuedByUserId) {
    return { ok: false, reason: 'INCOMPLETE' };
  }
  return {
    ok: true,
    claims: {
      kind: UAT_LAUNCH_KIND,
      jti: decoded.jti,
      testDataRunId: decoded.testDataRunId,
      runLabel: decoded.runLabel,
      issuedByUserId: decoded.issuedByUserId,
    },
  };
}

// ---------------------------------------------------------------------------
// Session cookie — what the rest of the booking runs on
// ---------------------------------------------------------------------------

export function signUatSessionCookie(ctx: UatContext): { value: string; expiresAt: Date } {
  const value = jwt.sign({ ...ctx, kind: UAT_SESSION_KIND }, secret(), {
    expiresIn: `${UAT_SESSION_TTL_MINUTES}m`,
  });
  return { value, expiresAt: new Date(Date.now() + UAT_SESSION_TTL_MINUTES * 60_000) };
}

/** Null for any problem — see `resolveUatFromRequest` for what null then means. */
export function verifyUatSessionCookie(value: string | null | undefined): UatContext | null {
  if (!value) return null;
  try {
    const decoded = jwt.verify(value, secret()) as Partial<UatContext> & { kind?: string };
    if (decoded.kind !== UAT_SESSION_KIND) return null;
    if (!decoded.testDataRunId || !decoded.runLabel || !decoded.issuedByUserId) return null;
    return {
      testDataRunId: decoded.testDataRunId,
      runLabel: decoded.runLabel,
      issuedByUserId: decoded.issuedByUserId,
    };
  } catch {
    return null;
  }
}

/**
 * Read one cookie from a raw `Cookie` header.
 *
 * Hand-rolled rather than adding cookie-parser: this is the only cookie the
 * platform reads, and a new dependency in a core flow needs approval it does not
 * warrant (CLAUDE.md §9).
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

export interface UatCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'none' | 'lax';
  path: string;
  expires?: Date;
}

/**
 * Cookie policy.
 *
 * SameSite=**Lax** is the default, including in production. There is no
 * cross-site embedding and no cross-site booking flow here: the tester opens
 * /book directly, and the page then calls the API from the same site whenever the
 * two share a registrable domain (e.g. book.example.com and api.example.com).
 * Https alone is not a reason to widen this.
 *
 * `UAT_COOKIE_CROSS_SITE=true` opts into SameSite=None for the one documented
 * case that genuinely fails under Lax: web and API deployed as separate services
 * under a PUBLIC-SUFFIX host, where each subdomain is its own registrable domain
 * and the browser therefore treats the call as cross-site. Render's default
 * `bsop-web.onrender.com` / `bsop-api.onrender.com` pair is exactly that; a
 * custom domain is not, and should stay on Lax.
 *
 * Secure is set in production regardless — and browsers require it for None, so
 * the widened setting can never be used over plain http.
 */
export function uatCookieOptions(expiresAt: Date): UatCookieOptions {
  const production = process.env.NODE_ENV === 'production';
  const crossSite = process.env.UAT_COOKIE_CROSS_SITE === 'true';
  return {
    httpOnly: true,
    secure: production,
    // None requires Secure; never emit that combination where it cannot be honoured.
    sameSite: crossSite && production ? 'none' : 'lax',
    path: '/',
    expires: expiresAt,
  };
}

/**
 * How to CLEAR the session — same attributes, no expiry, so the browser drops it.
 *
 * Used the moment a UAT booking completes. Without this the cookie would outlive
 * the thing it was for, and the tester's NEXT booking in the same browser — a real
 * one — would be silently tagged as test data and never notify the customer. A
 * bounded lifetime alone is not enough: the window is the whole problem.
 */
export function uatClearCookieOptions(): UatCookieOptions {
  const { expires: _ignored, ...rest } = uatCookieOptions(new Date(0));
  return rest;
}
