import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { AuthService } from '../auth.service';
import { ROLE_PERMISSIONS } from '../../../common/constants/permissions';

const ORIG = { allow: process.env.ALLOW_DEV_LOGIN, node: process.env.NODE_ENV, secret: process.env.JWT_SECRET };

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-xx'; });
afterEach(() => { process.env.ALLOW_DEV_LOGIN = ORIG.allow; process.env.NODE_ENV = ORIG.node; });
afterAll(() => {
  if (ORIG.secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = ORIG.secret;
});

function build() {
  const prisma: any = {
    userAccount: { findFirst: vi.fn() },
    // CR-2026-023 — dev-login opens an ephemeral sandbox TestDataRun.
    testDataRun: { create: vi.fn(async () => ({ id: 'run-xyz' })) },
  };
  const audit: any = { log: vi.fn(async () => ({})) };
  const sandbox: any = { getRunId: () => undefined, run: (_id: string, cb: any) => cb(), exit: (cb: any) => cb() };
  return { svc: new AuthService(prisma as any, audit as any, sandbox), prisma, audit };
}
const enable = () => { process.env.ALLOW_DEV_LOGIN = 'true'; process.env.NODE_ENV = 'development'; };
const disable = () => { process.env.ALLOW_DEV_LOGIN = 'false'; process.env.NODE_ENV = 'test'; };
const decode = (t: string) => jwt.decode(t) as any;

describe('normal login is unchanged after the refactor', () => {
  it('verifies the password and issues normal tokens with role permissions', async () => {
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce({
      id: 'u1', email: 'a@b', fullName: 'A', roleCode: 'MANAGER', siteId: null,
      passwordHash: bcrypt.hashSync('pw', 4), status: 'ACTIVE',
    });
    const res = await svc.login('a@b', 'pw');
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(decode(res.accessToken).role).toBe('MANAGER');
    expect(decode(res.accessToken).permissions).toEqual(ROLE_PERMISSIONS.MANAGER);
    expect(res.user).toMatchObject({ id: 'u1', roleCode: 'MANAGER' });
    // CR-2026-023 — normal login is NOT a sandbox session.
    expect(decode(res.accessToken).sandboxRunId).toBeUndefined();
    expect('sandboxRunId' in res).toBe(false);
    expect(prisma.testDataRun.create).not.toHaveBeenCalled();
  });

  it('rejects a bad password', async () => {
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce({
      id: 'u1', email: 'a@b', fullName: 'A', roleCode: 'MANAGER', siteId: null,
      passwordHash: bcrypt.hashSync('pw', 4), status: 'ACTIVE',
    });
    await expect(svc.login('a@b', 'wrong')).rejects.toThrow(/Invalid credentials/);
  });
});

describe('dev-login safety gate', () => {
  it('is DISABLED by default (flag off)', async () => {
    disable();
    const { svc } = build();
    await expect(svc.devLogin('ADMIN')).rejects.toThrow(/disabled/i);
    await expect(svc.listDevProfiles()).rejects.toThrow(/disabled/i);
  });

  it('REFUSES in production even when the flag is true', async () => {
    process.env.ALLOW_DEV_LOGIN = 'true';
    process.env.NODE_ENV = 'production';
    const { svc } = build();
    await expect(svc.devLogin('ADMIN')).rejects.toThrow(/disabled/i);
    await expect(svc.listDevProfiles()).rejects.toThrow(/disabled/i);
  });
});

describe('dev-login behaviour (enabled, non-production)', () => {
  it('ADMIN maps to the existing admin account (admin@bert.local)', async () => {
    enable();
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce({
      id: 'admin-1', email: 'admin@bert.local', fullName: 'Admin User', roleCode: 'ADMIN', siteId: null, status: 'ACTIVE',
    });
    const res = await svc.devLogin('ADMIN');
    expect(decode(res.accessToken).sub).toBe('admin-1');
    expect(decode(res.accessToken).role).toBe('ADMIN');
    expect(prisma.userAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'admin@bert.local', roleCode: 'ADMIN' }) }),
    );
    // CR-2026-023 — exactly one ACTIVE DEV_LOGIN_SESSION run; id returned + in the token.
    expect(prisma.testDataRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.testDataRun.create.mock.calls[0][0].data).toMatchObject({ runType: 'DEV_LOGIN_SESSION', status: 'ACTIVE', createdByUserId: 'admin-1' });
    expect(res.sandboxRunId).toBe('run-xyz');
    expect(decode(res.accessToken).sandboxRunId).toBe('run-xyz');
  });

  it('refuses unsupported / CUSTOMER roles', async () => {
    enable();
    const { svc } = build();
    await expect(svc.devLogin('CUSTOMER')).rejects.toThrow(/Unsupported/i);
    await expect(svc.devLogin('NONSENSE')).rejects.toThrow(/Unsupported/i);
  });

  it('gives a clear refusal when the mapped DEVTEST user is not seeded yet', async () => {
    enable();
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce(null);
    await expect(svc.devLogin('MANAGER')).rejects.toThrow(/not seeded/i);
  });

  it('keeps the chosen role but grants FULL permissions for the sandbox session + writes a DEV_LOGIN audit (CR-2026-047)', async () => {
    enable();
    const { svc, prisma, audit } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce({
      id: 'm1', email: 'devtest.manager@berts.local', fullName: 'DEVTEST Manager', roleCode: 'MANAGER', siteId: null, status: 'ACTIVE',
    });
    const res = await svc.devLogin('MANAGER');
    // Identity/role stays MANAGER (for audit + display) but the sandbox session can use every feature.
    expect(decode(res.accessToken).role).toBe('MANAGER');
    expect(decode(res.accessToken).permissions).toEqual(ROLE_PERMISSIONS.ADMIN);
    expect(decode(res.accessToken).permissions).not.toEqual(ROLE_PERMISSIONS.MANAGER);
    expect(res.refreshToken).toBeTruthy();
    expect(res.user).toMatchObject({ roleCode: 'MANAGER', email: 'devtest.manager@berts.local' });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEV_LOGIN', entityType: 'UserAccount', entityId: 'm1' }),
    );
    // no token/secret leaked into the audit payload
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(res.accessToken);
    // CR-2026-023 — sandbox session opened + claim present
    expect(res.sandboxRunId).toBe('run-xyz');
    expect(decode(res.accessToken).sandboxRunId).toBe('run-xyz');
  });

  it('refresh of a sandbox token preserves full access + the sandbox run id (CR-2026-047)', async () => {
    enable();
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce({
      id: 'm1', email: 'devtest.manager@berts.local', fullName: 'DEVTEST Manager', roleCode: 'MANAGER', siteId: null, status: 'ACTIVE',
    });
    const res = await svc.devLogin('MANAGER');
    prisma.userAccount.findUnique = vi.fn(async () => ({ id: 'm1', email: 'x', fullName: 'y', roleCode: 'MANAGER', siteId: null, status: 'ACTIVE' }));
    const refreshed = await svc.refresh(res.refreshToken);
    expect(decode(refreshed.accessToken).permissions).toEqual(ROLE_PERMISSIONS.ADMIN);
    expect(decode(refreshed.accessToken).sandboxRunId).toBe('run-xyz');
  });

  it('a sandbox token does NOT get full access when dev-login is disabled (defense-in-depth, CR-2026-047)', async () => {
    enable();
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValueOnce({
      id: 'm1', email: 'devtest.manager@berts.local', fullName: 'DEVTEST Manager', roleCode: 'MANAGER', siteId: null, status: 'ACTIVE',
    });
    const res = await svc.devLogin('MANAGER'); // minted while enabled
    // Now simulate the gate being off (e.g. production) at refresh time.
    disable();
    prisma.userAccount.findUnique = vi.fn(async () => ({ id: 'm1', email: 'x', fullName: 'y', roleCode: 'MANAGER', siteId: null, status: 'ACTIVE' }));
    const refreshed = await svc.refresh(res.refreshToken);
    expect(decode(refreshed.accessToken).permissions).toEqual(ROLE_PERMISSIONS.MANAGER);
  });

  it('listDevProfiles returns the 7 staff roles (no CUSTOMER) + availability + warning', async () => {
    enable();
    const { svc, prisma } = build();
    prisma.userAccount.findFirst.mockResolvedValue(null); // nothing seeded -> all unavailable
    const r = await svc.listDevProfiles();
    expect(r.enabled).toBe(true);
    expect(r.warning).toMatch(/Disabled in Production/i);
    expect(r.profiles).toHaveLength(7);
    expect(r.profiles.map((p: any) => p.role)).not.toContain('CUSTOMER');
    expect(r.profiles.every((p: any) => p.available === false)).toBe(true);
  });
});
