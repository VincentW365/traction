import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { signUatSession, verifyUatSession, UAT_SESSION_KIND, UAT_SESSION_TTL_MINUTES } from '../uat-session';
import { BookingSimulatorService } from '../booking-simulator.service';

/**
 * CR-2026-108 Stage 3 — the UAT booking session.
 *
 * Two things must hold at once: an administrator can make a brand-new customer's
 * booking disposable, and NOBODY ELSE can. A forgeable marker would let a stranger
 * book for free, never be notified, stay out of operational reporting, and be
 * deleted by a cleanup that believed the records were disposable.
 */
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
});

describe('UAT session token', () => {
  const claims = { testDataRunId: 'run-1', runLabel: 'uat-booking-1', issuedByUserId: 'admin-1' };

  it('round-trips the run it belongs to and who issued it', () => {
    const { token, expiresAt } = signUatSession(claims);
    const ctx = verifyUatSession(token);
    expect(ctx).toMatchObject(claims);
    // Attributable: every test booking traces back to the person who authorised it.
    expect(ctx!.issuedByUserId).toBe('admin-1');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('expires', () => {
    expect(UAT_SESSION_TTL_MINUTES).toBeLessThanOrEqual(60);
    const expired = jwt.sign({ ...claims, kind: UAT_SESSION_KIND }, process.env.JWT_SECRET!, { expiresIn: '-1s' });
    expect(verifyUatSession(expired)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ ...claims, kind: UAT_SESSION_KIND }, 'some-other-secret-at-least-32-chars-xx');
    expect(verifyUatSession(forged)).toBeNull();
  });

  /** A customer booking session must never be usable as a UAT session. */
  it('rejects a token of the wrong kind', () => {
    const customerSession = jwt.sign({ sub: 'cust-1', kind: 'booking-session' }, process.env.JWT_SECRET!);
    expect(verifyUatSession(customerSession)).toBeNull();
  });

  it('rejects a well-signed token missing its claims', () => {
    const hollow = jwt.sign({ kind: UAT_SESSION_KIND }, process.env.JWT_SECRET!);
    expect(verifyUatSession(hollow)).toBeNull();
  });

  it('treats absent or malformed input as no UAT context', () => {
    expect(verifyUatSession(null)).toBeNull();
    expect(verifyUatSession(undefined)).toBeNull();
    expect(verifyUatSession('')).toBeNull();
    expect(verifyUatSession('not-a-jwt')).toBeNull();
    // ...and "no context" means the booking proceeds as a REAL one. That is the
    // safe direction: loud and recoverable, rather than silently disposable.
  });
});

describe('BookingSimulatorService.startUatSession', () => {
  function build(over: { existingRun?: { id: string; status: string } | null } = {}) {
    const audits: Array<Record<string, unknown>> = [];
    const prisma = {
      testDataRun: {
        findUnique: vi.fn(async () => over.existingRun ?? null),
        create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'run-new', status: 'ACTIVE', ...a.data })),
      },
    };
    const audit = { log: vi.fn(async (d: Record<string, unknown>) => { audits.push(d); return d; }) };
    const service = new BookingSimulatorService(prisma as never, {} as never, audit as never);
    return { service, prisma, audits };
  }

  it('creates a test run, signs a session, and audits who authorised it', async () => {
    const h = build();
    const r = await h.service.startUatSession('admin-1', { label: 'uat-abc' });

    expect(r.runLabel).toBe('uat-abc');
    expect(verifyUatSession(r.token)).toMatchObject({ testDataRunId: 'run-new', issuedByUserId: 'admin-1' });
    expect(h.audits[0]).toMatchObject({
      actorUserId: 'admin-1',
      action: 'UAT_BOOKING_SESSION_STARTED',
      entityType: 'TestDataRun',
    });
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

  it('generates a label when none is given, so a tester cannot collide by accident', async () => {
    const h = build();
    const r = await h.service.startUatSession('admin-1');
    expect(r.runLabel).toMatch(/^uat-booking-/);
  });

  it('builds a launch link into the REAL /book flow, not a simulator-only path', async () => {
    const h = build();
    const r = await h.service.startUatSession('admin-1', { label: 'uat-abc', publicBaseUrl: 'https://book.example.com' });
    expect(r.bookingUrl).toContain('https://book.example.com/book?uat=');
    expect(r.bookingUrl).not.toContain('test=true');
    expect(r.bookingUrl).not.toContain('/admin');
  });
});
