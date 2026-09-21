import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as jwt from 'jsonwebtoken';
import {
  signUatLaunchToken,
  verifyUatLaunchToken,
  signUatSessionCookie,
  verifyUatSessionCookie,
  readCookie,
  uatCookieOptions,
  uatClearCookieOptions,
  UAT_LAUNCH_KIND,
  UAT_SESSION_KIND,
  UAT_LAUNCH_TTL_MINUTES,
  UAT_COOKIE_NAME,
} from '../uat-session';
import { BookingSimulatorService } from '../booking-simulator.service';

/**
 * CR-2026-108 Stage 3 (hardened) — the UAT booking session.
 *
 * Three things must hold at once:
 *  1. an administrator can make a brand-new customer's booking disposable;
 *  2. nobody else can — a forgeable marker would let a stranger book for free,
 *     never be notified, stay out of reporting, and be deleted by a cleanup that
 *     believed the records were disposable;
 *  3. a tester holding a DEAD link is told so, rather than silently creating a
 *     real customer and sending them a real message.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
});

const CTX = { testDataRunId: 'run-1', runLabel: 'uat-booking-1', issuedByUserId: 'admin-1' };

describe('UAT launch token', () => {
  it('round-trips the run, the label and who issued it, with a unique jti', () => {
    const a = signUatLaunchToken(CTX);
    const b = signUatLaunchToken(CTX);
    expect(a.jti).not.toBe(b.jti); // single-use handles must not collide
    const v = verifyUatLaunchToken(a.token);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims).toMatchObject({ ...CTX, jti: a.jti });
  });

  it('is redeemable for at most 30 minutes', () => {
    expect(UAT_LAUNCH_TTL_MINUTES).toBeLessThanOrEqual(30);
  });

  const rejected: Array<[string, string, string]> = [
    ['absent', '', 'MISSING'],
    ['malformed', 'not-a-jwt', 'MALFORMED'],
  ];
  for (const [name, token, reason] of rejected) {
    it(`rejects a ${name} token (${reason})`, () => {
      const v = verifyUatLaunchToken(token);
      expect(v).toEqual({ ok: false, reason });
    });
  }

  it('rejects an expired token, distinguishably', () => {
    const expired = jwt.sign({ ...CTX, kind: UAT_LAUNCH_KIND, jti: 'j1' }, process.env.JWT_SECRET!, { expiresIn: '-1s' });
    expect(verifyUatLaunchToken(expired)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ ...CTX, kind: UAT_LAUNCH_KIND, jti: 'j1' }, 'some-other-secret-at-least-32-chars-xx');
    expect(verifyUatLaunchToken(forged)).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  /** A session cookie must never be replayable as a launch token, or vice versa. */
  it('rejects a token of the wrong kind', () => {
    const sessionValue = signUatSessionCookie(CTX).value;
    expect(verifyUatLaunchToken(sessionValue)).toEqual({ ok: false, reason: 'WRONG_KIND' });
    const customerSession = jwt.sign({ sub: 'c1', kind: 'booking-session' }, process.env.JWT_SECRET!);
    expect(verifyUatLaunchToken(customerSession)).toEqual({ ok: false, reason: 'WRONG_KIND' });
  });

  it('rejects a well-signed token missing its claims', () => {
    const hollow = jwt.sign({ kind: UAT_LAUNCH_KIND }, process.env.JWT_SECRET!);
    expect(verifyUatLaunchToken(hollow)).toEqual({ ok: false, reason: 'INCOMPLETE' });
  });
});

describe('UAT session cookie', () => {
  it('round-trips the context', () => {
    const { value } = signUatSessionCookie(CTX);
    expect(verifyUatSessionCookie(value)).toEqual(CTX);
  });

  it('refuses a launch token used as a session cookie', () => {
    expect(verifyUatSessionCookie(signUatLaunchToken(CTX).token)).toBeNull();
  });

  it('refuses anything unverifiable', () => {
    expect(verifyUatSessionCookie(null)).toBeNull();
    expect(verifyUatSessionCookie('garbage')).toBeNull();
    expect(verifyUatSessionCookie(jwt.sign({ ...CTX, kind: UAT_SESSION_KIND }, 'wrong-secret-at-least-32-characters'))).toBeNull();
  });

  it('defaults to SameSite=Lax in production — https alone is not a reason to widen it', () => {
    const saved = { env: process.env.NODE_ENV, cross: process.env.UAT_COOKIE_CROSS_SITE };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.UAT_COOKIE_CROSS_SITE;
      const prod = uatCookieOptions(new Date());
      expect(prod.httpOnly).toBe(true);
      expect(prod.secure).toBe(true);
      expect(prod.sameSite).toBe('lax');
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.cross === undefined) delete process.env.UAT_COOKIE_CROSS_SITE; else process.env.UAT_COOKIE_CROSS_SITE = saved.cross;
    }
  });

  it('widens to None ONLY on the documented cross-site opt-in, and never without Secure', () => {
    const saved = { env: process.env.NODE_ENV, cross: process.env.UAT_COOKIE_CROSS_SITE };
    try {
      process.env.UAT_COOKIE_CROSS_SITE = 'true';
      process.env.NODE_ENV = 'production';
      const prod = uatCookieOptions(new Date());
      expect(prod.sameSite).toBe('none');
      expect(prod.secure).toBe(true);

      // Opting in outside production must NOT emit None: browsers reject
      // None without Secure, and the cookie would simply be dropped.
      process.env.NODE_ENV = 'development';
      const dev = uatCookieOptions(new Date());
      expect(dev.sameSite).toBe('lax');
      expect(dev.secure).toBe(false);
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.cross === undefined) delete process.env.UAT_COOKIE_CROSS_SITE; else process.env.UAT_COOKIE_CROSS_SITE = saved.cross;
    }
  });

  it('expires with the session, and the clear variant carries no expiry', () => {
    const at = new Date(Date.now() + 60 * 60_000);
    expect(uatCookieOptions(at).expires).toEqual(at);
    const cleared = uatClearCookieOptions();
    expect(cleared).not.toHaveProperty('expires');
    // Same attributes otherwise, or the browser will not match and drop it.
    expect(cleared.httpOnly).toBe(true);
    expect(cleared.path).toBe('/');
  });

  it('reads its cookie out of a raw header without a parser dependency', () => {
    expect(readCookie(`a=1; ${UAT_COOKIE_NAME}=abc.def; b=2`, UAT_COOKIE_NAME)).toBe('abc.def');
    expect(readCookie('other=1', UAT_COOKIE_NAME)).toBeNull();
    expect(readCookie(undefined, UAT_COOKIE_NAME)).toBeNull();
  });
});

describe('BookingSimulatorService — minting and redeeming', () => {
  function build(over: { existingRun?: { id: string; status: string } | null; redeemedJtis?: string[]; runStatus?: string; simulatorOff?: boolean } = {}) {
    const redeemed = new Set(over.redeemedJtis ?? []);
    const audits: Array<Record<string, unknown>> = [];
    const prisma = {
      testDataRun: {
        findUnique: vi.fn(async (a: { where: { label?: string; id?: string } }) =>
          a.where.label !== undefined ? (over.existingRun ?? null) : { status: over.runStatus ?? 'ACTIVE' },
        ),
        create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'run-new', status: 'ACTIVE', ...a.data })),
      },
      // CR-2026-116 — the simulator switch, read on every redemption.
      businessRuleConfig: {
        findFirst: vi.fn(async () => ({ valueJson: !over.simulatorOff })),
      },
      auditLog: {
        // Mirrors the real single-use check: has this jti already been redeemed?
        findFirst: vi.fn(async (a: { where: { afterJson?: { equals?: string } } }) =>
          a.where.afterJson?.equals && redeemed.has(a.where.afterJson.equals) ? { id: 'audit-1' } : null,
        ),
      },
    };
    const audit = {
      log: vi.fn(async (d: Record<string, unknown>) => {
        audits.push(d);
        const j = (d.afterJson as { jti?: string } | undefined)?.jti;
        if (d.action === 'UAT_BOOKING_SESSION_REDEEMED' && j) redeemed.add(j);
        return d;
      }),
    };
    // The UAT-session paths touch neither the resource snapshot nor the shadow
    // comparison, so those two collaborators stay unstubbed on purpose: a stub
    // here would quietly start passing if a session path grew a dependency on them.
    const service = new BookingSimulatorService(prisma as never, {} as never, audit as never, {} as never, {} as never);
    return { service, prisma, audits, redeemed };
  }

  it('creates a run, signs a launch token, and audits who authorised it', async () => {
    const h = build();
    const r = await h.service.startUatSession('admin-1', { label: 'uat-abc' });
    expect(r.runLabel).toBe('uat-abc');
    expect(verifyUatLaunchToken(r.token).ok).toBe(true);
    expect(h.audits[0]).toMatchObject({ actorUserId: 'admin-1', action: 'UAT_BOOKING_SESSION_STARTED' });
  });

  it('reuses an active run of the same label rather than duplicating it', async () => {
    const h = build({ existingRun: { id: 'run-existing', status: 'ACTIVE' } });
    const r = await h.service.startUatSession('admin-1', { label: 'uat-abc' });
    expect(h.prisma.testDataRun.create).not.toHaveBeenCalled();
    expect(r.testDataRunId).toBe('run-existing');
  });

  it('refuses to reopen a run that has already been cleaned up', async () => {
    const h = build({ existingRun: { id: 'run-old', status: 'CLEANED_UP' } });
    await expect(h.service.startUatSession('admin-1', { label: 'uat-abc' })).rejects.toThrow(/no longer active/);
  });

  it('builds a launch link into the REAL /book flow, never a simulator-only path', async () => {
    const h = build();
    const r = await h.service.startUatSession('admin-1', { label: 'uat-abc', publicBaseUrl: 'https://book.example.com' });
    expect(r.bookingUrl).toContain('https://book.example.com/book?uat=');
    expect(r.bookingUrl).not.toContain('test=true');
    expect(r.bookingUrl).not.toContain('/admin');
  });

  it('redeems a valid launch token into a session cookie and audits the exchange', async () => {
    const h = build();
    const { token } = await h.service.startUatSession('admin-1', { label: 'uat-abc' });

    const result = await h.service.redeemUatLaunchToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context).toMatchObject({ runLabel: 'uat-abc', issuedByUserId: 'admin-1' });
      expect(verifyUatSessionCookie(result.cookieValue)).toMatchObject({ runLabel: 'uat-abc' });
    }
    expect(h.audits.some((a) => a.action === 'UAT_BOOKING_SESSION_REDEEMED')).toBe(true);
  });

  /**
   * THE REPLAY TEST. A launch link is a privileged capability; once spent it must
   * be dead, including across a restart — which is why redemption is recorded in
   * the audit log rather than in process memory.
   */
  it('refuses a SECOND redemption of the same token', async () => {
    const h = build();
    const { token } = await h.service.startUatSession('admin-1', { label: 'uat-abc' });

    const first = await h.service.redeemUatLaunchToken(token);
    const replay = await h.service.redeemUatLaunchToken(token);

    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: false, reason: 'ALREADY_REDEEMED' });
  });

  it('refuses redemption when the run is no longer ACTIVE', async () => {
    const h = build({ runStatus: 'CLEANED_UP' });
    const { token } = await h.service.startUatSession('admin-1', { label: 'uat-abc' });
    const r = await h.service.redeemUatLaunchToken(token);
    expect(r.ok).toBe(false);
  });

  /**
   * CR-2026-116 — the simulator can be switched off between issuing a launch
   * link and someone clicking it. A token outstanding at that moment must not
   * still open a test session: "off" would otherwise hold everywhere except the
   * one path that creates test customers and captures their messages.
   */
  it('refuses a still-valid launch token once the simulator is switched off', async () => {
    const live = build();
    const { token } = await live.service.startUatSession('admin-1', { label: 'uat-abc' });
    // The same token, presented to a service whose switch is now off.
    const off = build({ simulatorOff: true });
    const r = await off.service.redeemUatLaunchToken(token);
    expect(r.ok).toBe(false);
    // Refused through the existing rejection route, so the tester is sent back
    // to the simulator rather than silently dropped into a REAL booking.
    expect(off.audits.some((a) => a.action === 'UAT_BOOKING_SESSION_REDEEMED')).toBe(false);
  });

  const badTokens: Array<[string, () => string]> = [
    ['expired', () => jwt.sign({ ...CTX, kind: UAT_LAUNCH_KIND, jti: 'x' }, process.env.JWT_SECRET!, { expiresIn: '-1s' })],
    ['forged', () => jwt.sign({ ...CTX, kind: UAT_LAUNCH_KIND, jti: 'x' }, 'other-secret-at-least-32-characters-x')],
    ['malformed', () => 'not-a-jwt'],
    ['wrong kind', () => signUatSessionCookie(CTX).value],
  ];
  for (const [name, make] of badTokens) {
    it(`refuses redemption of a ${name} token and records nothing`, async () => {
      const h = build();
      const r = await h.service.redeemUatLaunchToken(make());
      expect(r.ok).toBe(false);
      expect(h.audits.some((a) => a.action === 'UAT_BOOKING_SESSION_REDEEMED')).toBe(false);
    });
  }
});
