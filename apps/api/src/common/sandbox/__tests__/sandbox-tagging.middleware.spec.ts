import { describe, it, expect, vi } from 'vitest';
import { createSandboxTaggingMiddleware, SANDBOX_MOD_ERROR } from '../sandbox-tagging.middleware';

function setup(runId: string | undefined, owned: Record<string, boolean> = {}) {
  const writeManifestRef = vi.fn(async () => {});
  const isOwned = vi.fn(async (model: string, id: string) => owned[`${model}:${id}`] === true);
  const mw = createSandboxTaggingMiddleware({ getRunId: () => runId, writeManifestRef, isOwned });
  return { mw, writeManifestRef, isOwned };
}
const nextWith = (result: unknown) => vi.fn(async () => result);

describe('sandbox tagging middleware — no context = pass-through', () => {
  it('does nothing when there is no sandbox run (normal users/background jobs)', async () => {
    const { mw, writeManifestRef, isOwned } = setup(undefined);
    const next = nextWith({ id: 'x' });
    const data: any = {};
    const r = await mw({ model: 'Customer', action: 'create', args: { data } } as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(data.testDataRunId).toBeUndefined();
    expect(writeManifestRef).not.toHaveBeenCalled();
    expect(isOwned).not.toHaveBeenCalled();
    expect(r).toEqual({ id: 'x' });
  });
});

describe('sandbox tagging middleware — create tagging', () => {
  it('injects testDataRunId + writes a manifest ref for a column anchor (Customer)', async () => {
    const { mw, writeManifestRef } = setup('run-1');
    const data: any = { firstName: 'A' };
    await mw({ model: 'Customer', action: 'create', args: { data } } as any, nextWith({ id: 'c1' }));
    expect(data.testDataRunId).toBe('run-1');
    expect(writeManifestRef).toHaveBeenCalledWith('Customer', 'c1', 'run-1');
  });

  it('manifests a non-column FK entity (ServiceOrder) WITHOUT injecting a column', async () => {
    const { mw, writeManifestRef } = setup('run-1');
    const data: any = { serviceVisitId: 'v1' };
    await mw({ model: 'ServiceOrder', action: 'create', args: { data } } as any, nextWith({ id: 'so1' }));
    expect(data.testDataRunId).toBeUndefined();
    expect(writeManifestRef).toHaveBeenCalledWith('ServiceOrder', 'so1', 'run-1');
  });

  it('NEVER tags ExternalSystemRef/TestDataRun/AuditLog/StatusHistory/NotificationLog (no recursion/self-tag)', async () => {
    const { mw, writeManifestRef } = setup('run-1');
    for (const model of ['ExternalSystemRef', 'TestDataRun', 'AuditLog', 'StatusHistory', 'NotificationLog']) {
      const next = nextWith({ id: 'x' });
      const data: any = {};
      await mw({ model, action: 'create', args: { data } } as any, next);
      expect(next).toHaveBeenCalledOnce();
      expect(data.testDataRunId).toBeUndefined();
    }
    expect(writeManifestRef).not.toHaveBeenCalled();
  });
});

describe('sandbox tagging middleware — modification guard (column anchors only)', () => {
  it('allows update/delete of a sandbox-owned anchor', async () => {
    const { mw, isOwned } = setup('run-1', { 'Customer:c1': true });
    const upd = nextWith({ id: 'c1' });
    await mw({ model: 'Customer', action: 'update', args: { where: { id: 'c1' }, data: {} } } as any, upd);
    expect(isOwned).toHaveBeenCalledWith('Customer', 'c1', 'run-1');
    expect(upd).toHaveBeenCalledOnce();
  });

  it('blocks update/delete of a non-sandbox anchor', async () => {
    const { mw } = setup('run-1', {});
    const next = nextWith({});
    await expect(
      mw({ model: 'Vehicle', action: 'delete', args: { where: { id: 'real' } } } as any, next),
    ).rejects.toThrow(SANDBOX_MOD_ERROR);
    expect(next).not.toHaveBeenCalled();
  });

  it('default-denies bulk / non-id mutations on anchors', async () => {
    const { mw } = setup('run-1');
    await expect(mw({ model: 'Customer', action: 'deleteMany', args: { where: { email: 'x' } } } as any, nextWith({})))
      .rejects.toThrow(SANDBOX_MOD_ERROR);
    await expect(mw({ model: 'Customer', action: 'update', args: { where: { email: 'x' }, data: {} } } as any, nextWith({})))
      .rejects.toThrow(SANDBOX_MOD_ERROR);
  });

  it('does NOT guard non-anchor model updates (internal cascades keep working)', async () => {
    const { mw, isOwned } = setup('run-1');
    const next = nextWith({ id: 'so1' });
    await mw({ model: 'ServiceOrder', action: 'update', args: { where: { id: 'so1' }, data: {} } } as any, next);
    expect(isOwned).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
