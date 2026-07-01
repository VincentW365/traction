import { describe, it, expect, vi } from 'vitest';
import { ServiceVisitCompletionController } from '../status.controller';
import { AUDIT_ACTIONS } from '../../audit/audit.service';

/**
 * CR-2026-063 — parts-prepositioned acknowledgement (audit-backed, no schema change).
 * Current state is derived from the latest APPLIED/CLEARED audit row.
 */
function build(latest: any = null, visit: any = { id: 'sv-1' }) {
  const prisma: any = { serviceVisit: { findUnique: vi.fn(async () => visit) } };
  const audit: any = { log: vi.fn(async () => ({})), findLatest: vi.fn(async () => latest) };
  return { ctrl: new ServiceVisitCompletionController(prisma, audit), prisma, audit };
}
const user = { sub: 'user-1' } as any;

describe('ServiceVisitCompletionController — parts acknowledgement (CR-2026-063)', () => {
  it('acknowledges: logs PARTS_ACK_APPLIED and reports acknowledged with actor', async () => {
    const h = build({
      action: AUDIT_ACTIONS.PARTS_ACK_APPLIED,
      createdAt: new Date('2026-06-30T10:00:00Z'),
      actor: { fullName: 'Ann Advisor' },
    });
    const res: any = await h.ctrl.acknowledgeParts('sv-1', {}, user);

    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AUDIT_ACTIONS.PARTS_ACK_APPLIED,
        entityType: 'ServiceVisit',
        entityId: 'sv-1',
        actorUserId: 'user-1',
      }),
    );
    expect(res).toEqual(expect.objectContaining({ acknowledged: true, by: 'Ann Advisor' }));
  });

  it('clears: logs PARTS_ACK_CLEARED and reports not acknowledged', async () => {
    const h = build({ action: AUDIT_ACTIONS.PARTS_ACK_CLEARED, createdAt: new Date(), actor: { fullName: 'X' } });
    const res: any = await h.ctrl.acknowledgeParts('sv-1', { acknowledged: false }, user);

    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.PARTS_ACK_CLEARED }),
    );
    expect(res.acknowledged).toBe(false);
    expect(res.by).toBeNull();
  });

  it('getPartsAck derives acknowledged=true from the latest APPLIED row', async () => {
    const h = build({ action: AUDIT_ACTIONS.PARTS_ACK_APPLIED, createdAt: new Date(), actor: { fullName: 'Bo' } });
    const res: any = await h.ctrl.getPartsAck('sv-1');
    expect(res.acknowledged).toBe(true);
    expect(res.by).toBe('Bo');
  });

  it('getPartsAck reports not acknowledged when there is no audit row', async () => {
    const h = build(null);
    const res: any = await h.ctrl.getPartsAck('sv-1');
    expect(res).toEqual({ acknowledged: false, at: null, by: null });
  });

  it('404s when the visit does not exist', async () => {
    const h = build(null, null);
    await expect(h.ctrl.acknowledgeParts('missing', {}, user)).rejects.toThrow(/not found/i);
    expect(h.audit.log).not.toHaveBeenCalled();
  });
});
