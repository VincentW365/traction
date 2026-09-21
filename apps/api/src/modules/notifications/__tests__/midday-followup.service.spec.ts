import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationsService } from '../notifications.service';

/**
 * DMAIC Rule 2 — midday completion follow-up.
 * Site timezone America/Jamaica (UTC-5, no DST). `now` is injected for determinism.
 */
function completionEvent(createdAtIso: string, optIn = { email: true, sms: false }) {
  return {
    createdAt: new Date(createdAtIso),
    serviceVisit: {
      id: 'sv-1',
      customer: {
        firstName: 'Ann',
        phone: '+18760000000',
        email: 'ann@example.com',
        notificationOptInSms: optIn.sms,
        notificationOptInEmail: optIn.email,
      },
      vehicle: { plateNumber: 'ABC1234', make: 'Toyota', model: 'Corolla', modelYear: 2020 },
    },
  };
}

function build(events: any[], alreadySent = 0) {
  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ timezone: 'America/Jamaica' })) },
    queueEvent: { findMany: vi.fn(async () => events) },
    notificationLog: { count: vi.fn(async () => alreadySent) },
  };
  const provider: any = { send: vi.fn() };
  const service = new NotificationsService(prisma, provider, { emailConfigured: false, mode: 'LIVE' });
  const queueSpy = vi.spyOn(service, 'queue').mockResolvedValue('log-1');
  return { service, prisma, queueSpy };
}

// 2026-06-09: 20:00Z = 15:00 Jamaica (afternoon, same date) → "now"
const NOW = new Date('2026-06-09T20:00:00Z');

describe('sendMiddayCompletionFollowUp (DMAIC Rule 2)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends for a job COMPLETED before noon today (09:00 local)', async () => {
    // 14:00Z = 09:00 Jamaica, same date → before noon
    const h = build([completionEvent('2026-06-09T14:00:00Z')]);
    const res = await h.service.sendMiddayCompletionFollowUp('site-1', NOW);

    expect(res.sent).toBe(1);
    expect(h.queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'midday_followup', channel: 'EMAIL', entityId: 'sv-1' }),
    );
  });

  it('does NOT send for a job completed AFTER noon (13:00 local)', async () => {
    // 18:00Z = 13:00 Jamaica → after noon
    const h = build([completionEvent('2026-06-09T18:00:00Z')]);
    const res = await h.service.sendMiddayCompletionFollowUp('site-1', NOW);

    expect(res.sent).toBe(0);
    expect(h.queueSpy).not.toHaveBeenCalled();
  });

  it('is idempotent — skips a visit already followed up', async () => {
    const h = build([completionEvent('2026-06-09T14:00:00Z')], /* alreadySent */ 1);
    const res = await h.service.sendMiddayCompletionFollowUp('site-1', NOW);

    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(h.queueSpy).not.toHaveBeenCalled();
  });

  it('skips a completed-before-noon job when the customer has opted out of all channels', async () => {
    const h = build([completionEvent('2026-06-09T14:00:00Z', { email: false, sms: false })]);
    const res = await h.service.sendMiddayCompletionFollowUp('site-1', NOW);

    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    expect(h.queueSpy).not.toHaveBeenCalled();
  });
});
