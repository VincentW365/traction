import { describe, it, expect, vi } from 'vitest';
import { AppointmentsService } from '../appointments.service';

/**
 * DMAIC Rule 1 — same-day scheduling cutoff (site-local time, config-driven, audited override).
 * Site timezone America/Jamaica (UTC-5, no DST).
 */
function build(cfg: { cutoff?: string | null; enforced?: boolean | null }) {
  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ timezone: 'America/Jamaica' })) },
    businessRuleConfig: {
      findFirst: vi.fn(async (args: any) => {
        const key = args.where.ruleKey;
        if (key === 'same_day_appointment_cutoff_time')
          return cfg.cutoff === undefined ? { valueJson: '10:00' } : cfg.cutoff === null ? null : { valueJson: cfg.cutoff };
        if (key === 'manager_override_required_after_cutoff')
          return cfg.enforced === undefined ? { valueJson: true } : cfg.enforced === null ? null : { valueJson: cfg.enforced };
        return null;
      }),
    },
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new AppointmentsService(prisma as any, statusHistory as any, audit as any);
  return { service, prisma, audit };
}

// Jamaica is UTC-5: 16:00Z = 11:00 local (after 10:00); 13:00Z = 08:00 local (before 10:00).
const NOW_AFTER = new Date('2026-06-09T16:00:00Z'); // 11:00 Jamaica
const NOW_BEFORE = new Date('2026-06-09T13:00:00Z'); // 08:00 Jamaica
const SAME_DAY = new Date('2026-06-09T18:00:00Z'); // 13:00 Jamaica, same local date
const NEXT_DAY = new Date('2026-06-10T18:00:00Z');

describe('Rule 1: same-day cutoff', () => {
  it('blocks a same-day booking after the cutoff with no override', async () => {
    const h = build({ cutoff: '10:00', enforced: true });
    await expect(
      h.service.enforceSameDayCutoff(SAME_DAY, 'site-1', false, 'u1', NOW_AFTER),
    ).rejects.toThrow(/manager approval/i);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('allows + audits a same-day booking after cutoff WITH manager override', async () => {
    const h = build({ cutoff: '10:00', enforced: true });
    await expect(
      h.service.enforceSameDayCutoff(SAME_DAY, 'site-1', true, 'u1', NOW_AFTER),
    ).resolves.toBeUndefined();
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SAME_DAY_CUTOFF_OVERRIDE', actorUserId: 'u1' }),
    );
  });

  it('allows a same-day booking BEFORE the cutoff (no override needed)', async () => {
    const h = build({ cutoff: '10:00', enforced: true });
    await expect(
      h.service.enforceSameDayCutoff(SAME_DAY, 'site-1', false, 'u1', NOW_BEFORE),
    ).resolves.toBeUndefined();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('does not apply to a NEXT-day booking even after the cutoff', async () => {
    const h = build({ cutoff: '10:00', enforced: true });
    await expect(
      h.service.enforceSameDayCutoff(NEXT_DAY, 'site-1', false, 'u1', NOW_AFTER),
    ).resolves.toBeUndefined();
  });

  it('uses the cutoff from BusinessRuleConfig (not hard-coded 10:00)', async () => {
    // Configured cutoff 12:00 → 11:00 local is BEFORE cutoff → allowed despite being past 10:00.
    const h = build({ cutoff: '12:00', enforced: true });
    await expect(
      h.service.enforceSameDayCutoff(SAME_DAY, 'site-1', false, 'u1', NOW_AFTER),
    ).resolves.toBeUndefined();
  });

  it('respects the enforcement flag — disabled means no cutoff at all', async () => {
    const h = build({ cutoff: '10:00', enforced: false });
    await expect(
      h.service.enforceSameDayCutoff(SAME_DAY, 'site-1', false, 'u1', NOW_AFTER),
    ).resolves.toBeUndefined();
  });
});
