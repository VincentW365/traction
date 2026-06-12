import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../auth.service';

vi.mock('../../data-import/test-data/cleanup', () => ({
  loadCleanupPlan: vi.fn(),
  evaluateSafety: vi.fn(),
  executeCleanup: vi.fn(),
}));
import { loadCleanupPlan, evaluateSafety, executeCleanup } from '../../data-import/test-data/cleanup';

const ORIG = { allow: process.env.ALLOW_DEV_LOGIN, node: process.env.NODE_ENV };
beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-xx';
  process.env.ALLOW_DEV_LOGIN = 'true';
  process.env.NODE_ENV = 'development';
  vi.clearAllMocks();
});
afterEach(() => { process.env.ALLOW_DEV_LOGIN = ORIG.allow; process.env.NODE_ENV = ORIG.node; });

function build() {
  const prisma: any = {};
  const audit: any = { log: vi.fn() };
  const exitFn = vi.fn((cb: any) => cb());
  const sandbox: any = { getRunId: () => undefined, run: (_id: string, cb: any) => cb(), exit: exitFn };
  return { svc: new AuthService(prisma, audit, sandbox), exitFn };
}
const user = (sandboxRunId?: string): any => ({ sub: 'u1', role: 'MANAGER', siteId: null, permissions: [], ...(sandboxRunId ? { sandboxRunId } : {}) });

describe('dev sandbox cleanup — gating', () => {
  it('refuses when dev-login is disabled', async () => {
    process.env.ALLOW_DEV_LOGIN = 'false';
    await expect(build().svc.devSandboxCleanupPreview(user('run-1'))).rejects.toThrow(/disabled/i);
  });
  it('refuses in production even when the flag is true', async () => {
    process.env.NODE_ENV = 'production';
    await expect(build().svc.devSandboxCleanup(user('run-1'), 'CLEAN UP DEV SANDBOX')).rejects.toThrow(/disabled/i);
  });
  it('refuses a normal session with no sandboxRunId', async () => {
    await expect(build().svc.devSandboxCleanupPreview(user(undefined))).rejects.toThrow(/no active dev sandbox/i);
  });
});

describe('dev sandbox cleanup — preview (read-only)', () => {
  it('returns counts + uses the DEV_LOGIN_SESSION safety profile; never deletes', async () => {
    (loadCleanupPlan as any).mockResolvedValue({ run: { label: 'dev-session', status: 'ACTIVE', runType: 'DEV_LOGIN_SESSION' }, deleteCounts: { Customer: 1 }, totalRows: 2, facts: {} });
    (evaluateSafety as any).mockReturnValue({ pass: true, checks: [] });
    const r = await build().svc.devSandboxCleanupPreview(user('run-1'));
    expect(r.runId).toBe('run-1');
    expect(r.counts).toEqual({ Customer: 1 });
    expect(r.confirmationPhrase).toBe('CLEAN UP DEV SANDBOX');
    expect(evaluateSafety).toHaveBeenCalledWith(expect.anything(), 'DEV_LOGIN_SESSION');
    expect(executeCleanup).not.toHaveBeenCalled();
  });
});

describe('dev sandbox cleanup — commit', () => {
  it('requires the exact typed confirmation', async () => {
    await expect(build().svc.devSandboxCleanup(user('run-1'), 'clean up')).rejects.toThrow(/Confirmation text/i);
    expect(loadCleanupPlan).not.toHaveBeenCalled();
    expect(executeCleanup).not.toHaveBeenCalled();
  });
  it('refuses when the DEV_LOGIN_SESSION safety fails (no deletes)', async () => {
    (loadCleanupPlan as any).mockResolvedValue({ run: { runType: 'DEV_LOGIN_SESSION' }, deleteCounts: {}, facts: {} });
    (evaluateSafety as any).mockReturnValue({ pass: false, checks: [{ name: 'no placeholder customer', ok: false }] });
    await expect(build().svc.devSandboxCleanup(user('run-1'), 'CLEAN UP DEV SANDBOX')).rejects.toThrow(/safety failed/i);
    expect(executeCleanup).not.toHaveBeenCalled();
  });
  it('executes via sandbox.exit with the DEV_SANDBOX audit action on success', async () => {
    (loadCleanupPlan as any).mockResolvedValue({ run: { runType: 'DEV_LOGIN_SESSION' }, deleteCounts: {}, facts: {} });
    (evaluateSafety as any).mockReturnValue({ pass: true, checks: [] });
    (executeCleanup as any).mockResolvedValue({ runId: 'run-1', label: 'x', counts: {}, totalDeleted: 2, backup: '...' });
    const { svc, exitFn } = build();
    const r = await svc.devSandboxCleanup(user('run-1'), 'CLEAN UP DEV SANDBOX');
    expect(exitFn).toHaveBeenCalled(); // deletes run OUTSIDE the sandbox context
    expect(executeCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'run-1', actorUserId: 'u1', auditAction: 'DEV_SANDBOX_CLEANED_UP' }),
    );
    expect(r.totalDeleted).toBe(2);
  });
});
