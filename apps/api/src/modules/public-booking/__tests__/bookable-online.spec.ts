import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingRulesFromRows, BOOKING_DEFAULTS, BOOKING_RULE_KEYS } from '../booking.config';
import { PublicBookingService } from '../public-booking.service';

/**
 * CR-2026-108 Stage 4A — capability without behaviour change.
 *
 * `bookableOnline` defaults to FALSE, which is right: a diagnostic or highly
 * variable repair must be enabled deliberately, never inherited from `isActive`.
 * But that same default would empty the public service list the instant the
 * migration landed. So enforcement is a SEPARATE, configurable switch, and these
 * tests pin both halves: off = exactly today's behaviour, on = only approved
 * services — with the switch flipped by configuration, never by a redeploy.
 */

interface Svc {
  code: string;
  name: string;
  customerFacingName: string | null;
  family: string;
  baseDurationMinutes: number;
  // CR-2026-111b — the real query selects these, so the fixture must too, or it
  // models a query shape production no longer issues.
  sedanDurationMinutes: number | null;
  suvDurationMinutes: number | null;
}
const SERVICES: Svc[] = [
  { code: 'OIL-01', name: 'Oil Change — Standard', customerFacingName: null, family: 'LUBE', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null },
  { code: 'DIAG-01', name: 'Diagnostic Investigation', customerFacingName: null, family: 'DIAG', baseDurationMinutes: 60, sedanDurationMinutes: null, suvDurationMinutes: null },
];

function build(over: { rules?: Array<{ ruleKey: string; valueJson: unknown }>; services?: Svc[] } = {}) {
  // Typed parameter on purpose: a zero-arg mock gives calls[0] an empty-tuple type.
  const findMany = vi.fn(async (_args: { where: Record<string, unknown> }) => over.services ?? SERVICES);
  const prisma = {
    site: { findFirst: vi.fn(async () => ({ id: 'site-1', code: 'B01', name: 'Bert', timezone: 'America/Jamaica', ticketCode: 'B01' })) },
    businessRuleConfig: {
      findMany: vi.fn(async () => over.rules ?? []),
      // operating hours are loaded through the same table
      findFirst: vi.fn(async () => null),
    },
    serviceType: { findMany },
  };
  const eta = { loadRules: vi.fn(async () => ({ capacity: 2, defaultDurationMinutes: 80 })) };
  const service = new PublicBookingService(prisma as never, eta as never, {} as never, {} as never, {} as never);
  return { service, findMany };
}

describe('CR-2026-108 §4A — the rule itself', () => {
  it('is registered so it can be read and edited without a redeploy', () => {
    expect(BOOKING_RULE_KEYS).toContain('booking_enforce_online_bookable');
  });

  it('defaults to OFF — the migration must not change what customers see', () => {
    expect(BOOKING_DEFAULTS.enforceOnlineBookable).toBe(false);
    expect(bookingRulesFromRows([]).enforceOnlineBookable).toBe(false);
  });

  it('is configurable both ways, and junk falls back to off', () => {
    expect(bookingRulesFromRows([{ ruleKey: 'booking_enforce_online_bookable', valueJson: true }]).enforceOnlineBookable).toBe(true);
    expect(bookingRulesFromRows([{ ruleKey: 'booking_enforce_online_bookable', valueJson: false }]).enforceOnlineBookable).toBe(false);
    expect(bookingRulesFromRows([{ ruleKey: 'booking_enforce_online_bookable', valueJson: 'yes' }]).enforceOnlineBookable).toBe(false);
  });
});

describe('CR-2026-108 §4A — legacy mode (enforcement OFF)', () => {
  it('does NOT filter on bookableOnline, so /book cannot go blank on deploy', async () => {
    const h = build();
    await h.service.listServices();
    const where = h.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('bookableOnline');
    expect(where).toMatchObject({ isActive: true, isExternal: false });
  });

  it('offers every active, non-external service exactly as before', async () => {
    const h = build();
    const out = await h.service.listServices();
    expect(out.map((s) => s.code)).toEqual(['OIL-01', 'DIAG-01']);
  });
});

describe('CR-2026-108 §4A — enforced mode', () => {
  const ENFORCED = [{ ruleKey: 'booking_enforce_online_bookable', valueJson: true }];

  it('offers ONLY services explicitly approved for online booking', async () => {
    const h = build({ rules: ENFORCED });
    await h.service.listServices();
    expect(h.findMany.mock.calls[0][0].where).toMatchObject({ bookableOnline: true });
  });

  it('still honours the existing exclusions rather than replacing them', async () => {
    const h = build({ rules: [...ENFORCED, { ruleKey: 'booking_excluded_service_codes', valueJson: ['OIL-01'] }] });
    await h.service.listServices();
    const w = h.findMany.mock.calls[0][0].where;
    expect(w.bookableOnline).toBe(true);
    expect(w.code).toEqual({ notIn: ['OIL-01'] });
  });
});

describe('CR-2026-108 §4A — customer-facing name', () => {
  it('shows the customer-facing name when one is set', async () => {
    const h = build({
      services: [{ code: 'OIL-01', name: 'LOF PKG A (INT)', customerFacingName: 'Oil & filter change', family: 'LUBE', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null }],
    });
    const out = await h.service.listServices();
    expect(out[0].name).toBe('Oil & filter change');
  });

  it('falls back to the internal name, so nothing breaks before names are set', async () => {
    const h = build();
    const out = await h.service.listServices();
    expect(out[0].name).toBe('Oil Change — Standard');
  });

  it('treats a blank customer-facing name as unset rather than showing nothing', async () => {
    const h = build({
      services: [{ code: 'OIL-01', name: 'Oil Change', customerFacingName: '   ', family: 'LUBE', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null }],
    });
    const out = await h.service.listServices();
    expect(out[0].name).toBe('Oil Change');
  });
});

/**
 * CR-2026-108 Stage 4E — enforcement must be real, and must not strand anyone.
 *
 * Two failures to avoid, pulling in opposite directions:
 *  - filtering only the service LIST makes enforcement cosmetic: the page stops
 *    offering a diagnostic while the API still accepts one posted directly;
 *  - enforcing on the RESCHEDULE path would strand every customer holding a valid
 *    appointment for a service that is no longer publicly offered.
 */
/** One method's body: from its signature to the next member declaration. */
function methodBody(signature: string): string {
  const src = readFileSync(join(__dirname, '..', 'public-booking.service.ts'), 'utf8');
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`method not found: ${signature}`);
  const rest = src.slice(start + signature.length);
  // Stop at the next member declaration or its doc comment.
  const next = rest.search(/\n {2}(async |private |public |\/\*\*)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe('CR-2026-108 §4E — enforcement is real on new bookings', () => {
  const ENFORCED = [{ ruleKey: 'booking_enforce_online_bookable', valueJson: true }];

  it('the confirm path requires bookableOnline, not just the list', async () => {
    const h = build({ rules: ENFORCED });
    // resolveServices is exercised through availability(); assert the predicate.
    await h.service.listServices();
    const listWhere = h.findMany.mock.calls[0][0].where;
    expect(listWhere).toMatchObject({ bookableOnline: true });

    const src = readFileSync(join(__dirname, '..', 'public-booking.service.ts'), 'utf8');
    const resolve = src.slice(src.indexOf('private async resolveServices'));
    const body = resolve.slice(0, resolve.indexOf('\n  }'));
    // The same predicate must appear on the NEW-booking resolver.
    expect(body).toContain('enforceOnlineBookable');
    expect(body).toContain('bookableOnline: true');
  });

  it('legacy mode leaves the confirm path completely unfiltered', () => {
    const src = readFileSync(join(__dirname, '..', 'public-booking.service.ts'), 'utf8');
    const resolve = src.slice(src.indexOf('private async resolveServices'));
    const body = resolve.slice(0, resolve.indexOf('\n  }'));
    // Conditional spread, not an unconditional filter.
    expect(body).toMatch(/\.\.\.\(rules\.enforceOnlineBookable \?/);
  });

  /**
   * Grandfathering is STRUCTURAL: reschedule reads its services from the
   * appointment and never calls resolveServices. This pins that, because the
   * tempting "tidy-up" of routing reschedule through the same resolver would
   * silently strand existing customers.
   */
  it('rescheduling reads services from the appointment, never from the resolver', () => {
    const body = methodBody('async rescheduleByCustomer');
    expect(body).toContain('appt.services.map((s) => s.serviceType)');
    expect(body).not.toContain('resolveServices');
  });

  it('cancelling never re-validates the service either', () => {
    const body = methodBody('async cancelByCustomer');
    expect(body).not.toContain('resolveServices');
    expect(body).not.toContain('bookableOnline');
  });

  /** Staff eligibility is a different question and must stay unaffected. */
  it('staff appointment creation is not filtered by bookableOnline', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'appointments', 'appointments.service.ts'), 'utf8');
    expect(src).not.toContain('bookableOnline');
  });
});
