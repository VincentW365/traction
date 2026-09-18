import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canReceiveWork, effectiveOperationalState, occupancyChip, operationalChip, resourceStatusView } from '../resource-status';

/**
 * CR-2026-111e — a bay nobody can use must never read as the best bay on the board.
 *
 * The underlying model is correct and unchanged: occupancy and operational condition
 * are separate, and both happen to use the word "AVAILABLE" for their own meaning.
 * The dispatch board printed the occupancy word, so a bay in MAINTENANCE with
 * nothing in it showed a green "Available" chip.
 *
 * These tests pin the WORDING, which is the whole of the fix.
 */

const root = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('the two states are never confused in words', () => {
  it('an operational resource reads "Operational", never "Available"', () => {
    expect(operationalChip('AVAILABLE').label).toBe('Operational');
  });

  it('an unoccupied resource reads "Available" — the occupancy question', () => {
    expect(occupancyChip('AVAILABLE').label).toBe('Available');
  });

  it('the graded operational words are the API\'s own four states', () => {
    expect(operationalChip('TEMPORARILY_UNAVAILABLE').label).toBe('Temporarily Unavailable');
    expect(operationalChip('MAINTENANCE').label).toBe('Maintenance');
    expect(operationalChip('OUT_OF_SERVICE').label).toBe('Out of Service');
  });

  it('an unrecognised state degrades to "Unknown" rather than printing a raw enum', () => {
    expect(operationalChip('SOMETHING_NEW').label).toBe('Unknown');
    expect(occupancyChip('SOMETHING_NEW').label).toBe('Unknown');
    expect(operationalChip('SOMETHING_NEW').label).not.toMatch(/_/);
  });

  it('a missing state is treated as operational / unoccupied, matching the API default', () => {
    expect(operationalChip(null).label).toBe('Operational');
    expect(occupancyChip(undefined).label).toBe('Available');
  });
});

describe('canReceiveWork', () => {
  it('is true only for the AVAILABLE operational state', () => {
    expect(canReceiveWork('AVAILABLE')).toBe(true);
    expect(canReceiveWork(null)).toBe(true);
    for (const s of ['TEMPORARILY_UNAVAILABLE', 'MAINTENANCE', 'OUT_OF_SERVICE']) {
      expect(canReceiveWork(s), s).toBe(false);
    }
  });
});

describe('the operational state leads whenever work cannot be taken', () => {
  /** The exact case from the audit: empty bay, under maintenance. */
  it('an EMPTY bay in MAINTENANCE leads with "Maintenance", not "Available"', () => {
    const v = resourceStatusView({ operationalState: 'MAINTENANCE', occupancy: 'AVAILABLE' });
    expect(v.lead.label).toBe('Maintenance');
    expect(v.blocked).toBe(true);
    expect(v.secondary.label).toBe('Not currently occupied');
    // The word that caused the confusion must not be the headline.
    expect(v.lead.label).not.toBe('Available');
  });

  it('the secondary line states the bay is empty without implying it is usable', () => {
    const v = resourceStatusView({ operationalState: 'OUT_OF_SERVICE', occupancy: 'AVAILABLE' });
    expect(v.secondary.label).toBe('Not currently occupied');
    expect(v.secondary.muted).toBe(true);
    expect(v.secondary.label).not.toMatch(/ready|assign|use it/i);
  });

  it('a bay taken down while a vehicle is still in it says so', () => {
    const v = resourceStatusView({ operationalState: 'MAINTENANCE', occupancy: 'OCCUPIED' });
    expect(v.lead.label).toBe('Maintenance');
    expect(v.secondary.label).toBe('Still has a vehicle in it');
  });

  it.each(['TEMPORARILY_UNAVAILABLE', 'MAINTENANCE', 'OUT_OF_SERVICE'])('%s leads and is never green', (state) => {
    const v = resourceStatusView({ operationalState: state, occupancy: 'AVAILABLE' });
    expect(v.blocked).toBe(true);
    expect(v.lead.label).toBe(operationalChip(state).label);
    expect(v.lead.badge).not.toContain('emerald');
    expect(v.stripe).not.toContain('emerald');
  });
});

/**
 * The Dispatch Board's own "Mark down" button posts to a DIFFERENT endpoint
 * (`/operational-status`) which flips `isOperational` and leaves the graded state
 * at AVAILABLE. Reading the graded word alone would show a bay marked down from the
 * board as green and "Available" — the original defect, by the commonest path.
 */
describe('a resource marked down by the boolean toggle is still blocked', () => {
  it('isOperational:false with no graded state leads with "Temporarily Unavailable"', () => {
    const v = resourceStatusView({ isOperational: false, operationalState: 'AVAILABLE', occupancy: 'AVAILABLE' });
    expect(v.blocked).toBe(true);
    expect(v.lead.label).toBe('Temporarily Unavailable');
    expect(v.lead.label).not.toBe('Available');
    expect(v.lead.badge).not.toContain('emerald');
  });

  it('a graded state still wins over the generic wording', () => {
    expect(effectiveOperationalState(false, 'MAINTENANCE')).toBe('MAINTENANCE');
    expect(effectiveOperationalState(false, 'OUT_OF_SERVICE')).toBe('OUT_OF_SERVICE');
  });

  it('it does not invent a reason nobody gave', () => {
    const v = resourceStatusView({ isOperational: false, operationalState: 'AVAILABLE', occupancy: 'AVAILABLE' });
    expect(v.lead.label).not.toBe('Maintenance');
  });

  it('an operational resource is unaffected by the reconciliation', () => {
    expect(effectiveOperationalState(true, 'AVAILABLE')).toBe('AVAILABLE');
    expect(effectiveOperationalState(undefined, null)).toBe('AVAILABLE');
  });

  it('the dispatch card passes BOTH signals, not just the graded word', () => {
    const dispatch = read('app/(dashboard)/dispatch/page.tsx');
    expect(dispatch).toContain('resourceStatusView({ isOperational: r.isOperational');
  });
});

describe('occupancy leads only when the resource can actually take work', () => {
  it('an operational, empty bay leads with "Available"', () => {
    const v = resourceStatusView({ operationalState: 'AVAILABLE', occupancy: 'AVAILABLE' });
    expect(v.lead.label).toBe('Available');
    expect(v.blocked).toBe(false);
    expect(v.secondary.label).toBe('Operational');
  });

  it('an operational, occupied bay leads with "In use"', () => {
    const v = resourceStatusView({ operationalState: 'AVAILABLE', occupancy: 'OCCUPIED' });
    expect(v.lead.label).toBe('In use');
    expect(v.blocked).toBe(false);
  });

  it('an operational, reserved bay leads with "Reserved"', () => {
    expect(resourceStatusView({ operationalState: 'AVAILABLE', occupancy: 'RESERVED' }).lead.label).toBe('Reserved');
  });
});

describe('Tailwind can see every colour class', () => {
  /**
   * A composed class like `border-l-${tone}` is purged at build time and the stripe
   * silently vanishes. Every class this module hands to a component is a literal.
   */
  it('no chip class is assembled from a template', () => {
    // Comments stripped first: the module deliberately NAMES the bad pattern in prose
    // to explain why it is avoided, and prose is not what Tailwind purges.
    const code = read('lib/resource-status.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/`(bg|text|border)-[a-z]*-?\$\{/);
  });

  it('every state has a full set of literal classes', () => {
    for (const s of ['AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'MAINTENANCE', 'OUT_OF_SERVICE']) {
      const c = operationalChip(s);
      expect(c.badge, s).toMatch(/^bg-[a-z]+-\d+ text-[a-z]+-\d+$/);
      expect(c.dot, s).toMatch(/^bg-[a-z]+-\d+$/);
      expect(c.border, s).toMatch(/^border-l-[a-z]+-\d+$/);
    }
  });
});

describe('the screens use the shared vocabulary', () => {
  const dispatch = read('app/(dashboard)/dispatch/page.tsx');
  const admin = read('app/(dashboard)/admin/resources/page.tsx');

  it('the dispatch card derives its chip from the shared helper', () => {
    expect(dispatch).toContain("from '../../../lib/resource-status'");
    expect(dispatch).toContain('const view = resourceStatusView({');
    expect(dispatch).toContain('occupancy: r.status');
  });

  it('the dispatch card no longer hard-codes "Down for maintenance" for every downed state', () => {
    // It said "maintenance" even when the resource was OUT_OF_SERVICE.
    expect(dispatch).not.toContain('Down for maintenance');
    expect(dispatch).toContain('Cannot take work —');
  });

  it('neither screen prints a raw occupancy or operational enum', () => {
    for (const [name, src] of [['dispatch', dispatch], ['admin', admin]] as const) {
      expect(src, name).not.toMatch(/>\s*\{?\s*['"`]?(OUT_OF_SERVICE|TEMPORARILY_UNAVAILABLE)['"`]?\s*\}?\s*</);
    }
  });

  it('the admin page takes its operational labels from the same module', () => {
    expect(admin).toContain("from '../../../../lib/resource-status'");
    expect(admin).toMatch(/AVAILABLE: operationalChip\('AVAILABLE'\)\.label/);
  });

  it('the admin card names occupancy even when the resource is empty', () => {
    expect(admin).toContain('Not occupied');
  });

  /** The gate on "Ready for assignment" is behaviour, and must still require both. */
  it('the dispatch board still offers assignment only when operational AND unoccupied', () => {
    expect(dispatch).toMatch(/r\.isOperational && r\.status === 'AVAILABLE'/);
    expect(dispatch).toContain('Ready for assignment');
  });
});
