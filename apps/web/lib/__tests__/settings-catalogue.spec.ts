import { describe, it, expect } from 'vitest';
import {
  HIDDEN_RULE_KEYS,
  SETTINGS_CATEGORIES,
  SETTINGS_LAUNCHPADS,
  catalogued,
  choiceLabel,
  displayValue,
  findCategory,
  findSetting,
  humaniseDays,
  humaniseMinutes,
  linkIsAvailable,
  to12Hour,
} from '../settings-catalogue';

/**
 * CR-2026-109 — the wording layer.
 *
 * The rule these tests exist to protect: presentation work must never make a
 * live business rule unreachable. It is very easy, while tidying a screen, to
 * quietly drop a setting that somebody depends on — and nothing about the
 * database changes, so nothing fails until a manager goes looking for a control
 * that is no longer there.
 */

describe('nothing becomes unreachable', () => {
  it('no key is catalogued twice, which would put one control in two places', () => {
    const keys = catalogued();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('no catalogued key is also hidden — a setting cannot be both offered and suppressed', () => {
    const both = catalogued().filter((k) => HIDDEN_RULE_KEYS.has(k));
    expect(both).toEqual([]);
  });

  it('every category slug is unique and routable', () => {
    const slugs = [...SETTINGS_CATEGORIES.map((c) => c.slug), ...SETTINGS_LAUNCHPADS.map((l) => l.slug), 'other'];
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z-]+$/);
  });

  it('every category can be found by its slug', () => {
    for (const c of SETTINGS_CATEGORIES) expect(findCategory(c.slug)).toBe(c);
    expect(findCategory('does-not-exist')).toBeUndefined();
  });
});

describe('every setting is described in business language', () => {
  const all = SETTINGS_CATEGORIES.flatMap((c) => c.sections.flatMap((s) => s.settings));

  it('has a label that is not the database key', () => {
    for (const s of all) {
      expect(s.label, s.key).not.toBe(s.key);
      // A label built from the key would still read as a key.
      expect(s.label, s.key).not.toMatch(/_/);
    }
  });

  it('has a sentence of help, not a fragment', () => {
    for (const s of all) {
      expect(s.help.length, s.key).toBeGreaterThan(20);
      expect(s.help, s.key).toMatch(/[.!]$/);
    }
  });

  it('never exposes a raw stored value as a choice label', () => {
    for (const s of all) {
      for (const c of s.choices ?? []) {
        // The VALUE stays as stored; only the label is readable.
        expect(c.label, `${s.key}=${c.value}`).not.toBe(c.value);
        expect(c.label, `${s.key}=${c.value}`).not.toMatch(/^[A-Z_]+$/);
      }
    }
  });

  it('gives every number a unit, so nothing is guessed from the label', () => {
    for (const s of all.filter((x) => x.control === 'number')) {
      expect(s.unit, s.key).toBeTruthy();
    }
  });

  it('spells out the consequence wherever a setting is marked significant', () => {
    for (const s of all.filter((x) => x.impact)) {
      expect(s.impact!.length, s.key).toBeGreaterThan(40);
    }
  });

  it('marks the changes management called out as consequential', () => {
    for (const key of [
      'booking_capacity_mode',
      'appointment_duration_source',
      'booking_enabled',
      'booking_max_concurrent_appointments',
      'booking_enforce_online_bookable',
    ]) {
      expect(findSetting(key)?.impact, key).toBeTruthy();
    }
  });
});

describe('the specific renamings management asked for', () => {
  it.each([
    ['booking_enabled', 'Online Booking'],
    ['booking_min_notice_minutes', 'Minimum Booking Notice'],
    ['booking_advance_window_days', 'How Far Ahead Customers Can Book'],
    ['customer_booking_latest_start', 'Latest Customer Appointment Start'],
    ['booking_same_day_allowed', 'Allow Same-Day Booking'],
    ['appointment_duration_source', 'Appointment Duration Model'],
    ['booking_capacity_mode', 'Capacity Model'],
    ['booking_enforce_online_bookable', 'Use Approved Online Service Catalogue'],
    ['booking_max_concurrent_appointments', 'Concurrent Appointment Limit'],
  ])('%s reads as "%s"', (key, label) => {
    expect(findSetting(key)?.label).toBe(label);
  });
});

describe('inactive configuration does not look active', () => {
  it('the concurrency limit is gated on the fixed model', () => {
    const s = findSetting('booking_max_concurrent_appointments')!;
    expect(s.activeWhen).toMatchObject({ key: 'booking_capacity_mode', equals: 'FIXED' });
    expect(s.activeWhen!.inactiveNote).toContain('workshop resources');
  });

  it('the standard length is gated on the standard duration model', () => {
    const s = findSetting('default_appointment_duration_minutes')!;
    expect(s.activeWhen).toMatchObject({ key: 'appointment_duration_source', equals: 'DEFAULT' });
  });

  it('every gate points at a setting that exists, or it can never resolve', () => {
    const all = SETTINGS_CATEGORIES.flatMap((c) => c.sections.flatMap((s) => s.settings));
    for (const s of all.filter((x) => x.activeWhen)) {
      expect(findSetting(s.activeWhen!.key), `${s.key} gates on ${s.activeWhen!.key}`).toBeTruthy();
    }
  });
});

describe('progressive disclosure', () => {
  it('leaves the settings a manager decides about in plain sight', () => {
    const booking = findCategory('booking')!;
    const online = booking.sections.find((s) => s.title === 'Online booking')!;
    const upfront = online.settings.filter((s) => !s.advanced).map((s) => s.key);
    expect(upfront).toContain('booking_enabled');
    expect(upfront).toContain('booking_min_notice_minutes');
    // Abuse protection is real, but it is not an operational decision.
    expect(upfront).not.toContain('booking_rate_limit_per_10_min');
  });

  it('never titles a section "Advanced", which the disclosure inside it already says', () => {
    // Such a section renders as "Advanced" wrapping "Advanced settings (n)" —
    // the same word twice, one nested in the other. An all-advanced section is
    // fine; naming it after its own disclosure is not.
    for (const c of SETTINGS_CATEGORIES) {
      for (const s of c.sections) {
        expect(s.title.toLowerCase(), `${c.slug}/${s.title}`).not.toContain('advanced');
      }
    }
  });

  it('gives an all-advanced section a title that says what it is about', () => {
    for (const c of SETTINGS_CATEGORIES) {
      for (const s of c.sections) {
        if (s.settings.length === 0 || s.settings.some((x) => !x.advanced)) continue;
        // It will render as a heading over a disclosure, so the heading has to
        // carry the meaning on its own.
        expect(s.title.length, `${c.slug}/${s.title}`).toBeGreaterThan(4);
      }
    }
  });
});

describe('values read the way a person would say them', () => {
  it('shows a 24-hour time as a wall clock', () => {
    expect(to12Hour('15:00')).toBe('3:00 PM');
    expect(to12Hour('00:30')).toBe('12:30 AM');
    expect(to12Hour('12:00')).toBe('12:00 PM');
    expect(to12Hour('09:05')).toBe('9:05 AM');
  });

  it('refuses anything that is not a time rather than inventing one', () => {
    for (const bad of ['', 'nonsense', '25:00', null, 15, undefined]) {
      expect(to12Hour(bad)).toBeNull();
    }
  });

  it('translates minutes into hours once it is worth doing', () => {
    expect(humaniseMinutes(120)).toBe('2 hours');
    expect(humaniseMinutes(60)).toBe('1 hour');
    expect(humaniseMinutes(90)).toBe('1 hr 30 min');
    // Below an hour the raw number is already the clearest form.
    expect(humaniseMinutes(30)).toBeNull();
    expect(humaniseMinutes(0)).toBeNull();
  });

  it('translates day counts into periods', () => {
    expect(humaniseDays(30)).toBe('about a month');
    expect(humaniseDays(14)).toBe('2 weeks');
    expect(humaniseDays(7)).toBe('1 week');
    expect(humaniseDays(3)).toBeNull();
  });

  it('uses the readable label for a stored enum', () => {
    expect(choiceLabel(findSetting('booking_capacity_mode'), 'FIXED')).toBe('Fixed limit');
    expect(choiceLabel(findSetting('appointment_duration_source'), 'DEFAULT')).toBe('Standard length');
    // An unrecognised value falls back rather than rendering nothing.
    expect(choiceLabel(findSetting('booking_capacity_mode'), 'MYSTERY')).toBe('MYSTERY');
  });

  it('summarises any value without leaking its storage shape', () => {
    expect(displayValue(findSetting('booking_enabled'), true)).toBe('On');
    expect(displayValue(findSetting('booking_enabled'), false)).toBe('Off');
    expect(displayValue(findSetting('customer_booking_latest_start'), '15:00')).toBe('3:00 PM');
    expect(displayValue(findSetting('booking_min_notice_minutes'), 120)).toBe('120 minutes');
    expect(displayValue(findSetting('booking_closed_dates'), [])).toBe('None');
    expect(displayValue(findSetting('booking_closed_dates'), ['2026-12-25'])).toBe('1 item');
    expect(displayValue(findSetting('operating_hours'), { schedule: {} })).toBe('Configured');
    expect(displayValue(undefined, null)).toBe('Not set');
  });
});

describe('related tools are reachable from where the decision is made', () => {
  it('booking links to the simulator and the catalogue', () => {
    const hrefs = findCategory('booking')!.links!.map((l) => l.href);
    expect(hrefs).toContain('/admin/testing/booking');
    expect(hrefs).toContain('/admin/service-catalogue');
  });

  it('capacity links to both resource screens', () => {
    const hrefs = findCategory('capacity')!.links!.map((l) => l.href);
    expect(hrefs).toContain('/admin/resources');
    expect(hrefs).toContain('/admin/resources/reconciliation');
  });

  it('every link is an in-app path, never an external or dead one', () => {
    const all = [
      ...SETTINGS_CATEGORIES.flatMap((c) => c.links ?? []),
      ...SETTINGS_LAUNCHPADS.flatMap((l) => l.links),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) expect(l.href, l.label).toMatch(/^\/admin\//);
  });
});

/**
 * CR-2026-116 — the Booking Simulator can be switched off, and then no screen
 * may offer a way into it.
 */
describe('links to a switched-off tool', () => {
  const simulatorLinks = [
    findCategory('booking')!.links!.find((l) => l.href === '/admin/testing/booking')!,
    SETTINGS_LAUNCHPADS.find((l) => l.slug === 'system')!.links.find((l) => l.href === '/admin/testing/booking')!,
  ];

  it('every route to the simulator is tied to the switch', () => {
    expect(simulatorLinks).toHaveLength(2);
    for (const l of simulatorLinks) expect(l.requiresRule).toBe('booking_simulator_enabled');
  });

  it('is offered while the rule is on, and withdrawn when it is off', () => {
    for (const l of simulatorLinks) {
      expect(linkIsAvailable(l, () => true)).toBe(true);
      expect(linkIsAvailable(l, () => false)).toBe(false);
    }
  });

  it('is offered when the deployment has no row for the rule yet', () => {
    // undefined means "the migration has not run here", not "off". Introducing
    // a switch must never be what removes a working tool.
    for (const l of simulatorLinks) expect(linkIsAvailable(l, () => undefined)).toBe(true);
  });

  it('leaves every link that names no rule alone', () => {
    expect(linkIsAvailable({ href: '/admin/service-catalogue' } as { requiresRule?: string }, () => false)).toBe(true);
  });

  it('puts the switch itself outside the tool it hides', () => {
    // A setting reachable only through the thing it can hide is a one-way door.
    const keys = findCategory('booking')!.sections.flatMap((s) => s.settings.map((x) => x.key));
    expect(keys).toContain('booking_simulator_enabled');
  });
});
