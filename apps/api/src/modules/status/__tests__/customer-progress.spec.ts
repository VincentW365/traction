import { describe, it, expect } from 'vitest';
import { StatusController } from '../status.controller';

/**
 * CR-2026-084 — the customer-facing progress bar.
 *
 * Two changes are pinned here:
 *
 * 1. "Called" was removed from the progression. It is an internal dispatch state
 *    (a bay has been claimed) that happens after the customer has already handed
 *    the car over, so it told them nothing and its copy — "please proceed to the
 *    service area" — was actively wrong.
 *
 * 2. The step is the FURTHEST of the ticket's and the visit's status, not simply
 *    the ticket's. QueueDisplayStatus has no member for QC or "ready for pickup",
 *    so the ticket sits at IN_SERVICE while the visit moves on; preferring the
 *    ticket pinned finished cars at "In Service".
 */
const controller = new StatusController(null as any);
const stepOf = (s: string) => (controller as any).stepOf(s) as number;
const currentStep = (ticket: string, visit: string) =>
  (controller as any).getCurrentStep(ticket, visit) as number;

// 0 = Checked In · 1 = In Queue · 2 = In Service · 3 = Ready
describe('customer progress steps', () => {
  it('maps the queue states to "In Queue"', () => {
    for (const s of ['WAITING', 'BLOCKED', 'PENDING_RANK', 'QUEUED', 'ISSUED']) {
      expect(stepOf(s)).toBe(1);
    }
  });

  it('treats CALLED as still waiting rather than its own step', () => {
    expect(stepOf('CALLED')).toBe(1);
  });

  it('maps work and completion states', () => {
    expect(stepOf('IN_SERVICE')).toBe(2);
    for (const s of ['READY_FOR_PICKUP', 'CLOSED', 'COMPLETED']) {
      expect(stepOf(s)).toBe(3);
    }
  });

  it('keeps a car in QC at "In Service", not "Ready"', () => {
    // Announcing "ready for pickup" during the quality check sent customers to the
    // counter early, and a failed QC then ran the bar backwards to "In Queue".
    expect(stepOf('QC')).toBe(2);
    expect(stepOf('QC')).toBeLessThan(stepOf('READY_FOR_PICKUP'));
  });

  it('falls back to "Checked In" for arrival states and empty input', () => {
    expect(stepOf('CHECKED_IN')).toBe(0);
    expect(stepOf('ARRIVED')).toBe(0);
    expect(stepOf('')).toBe(0);
  });

  it('never exceeds the last step, so the bar cannot overflow', () => {
    const FINAL = 3;
    for (const s of ['CLOSED', 'COMPLETED', 'READY_FOR_PICKUP']) {
      expect(stepOf(s)).toBeLessThanOrEqual(FINAL);
    }
  });

  describe('resolving ticket vs visit', () => {
    it('advances with the visit when the ticket lags behind', () => {
      // The exact shape of the bug: work started, visit is IN_SERVICE, but the
      // ticket had not been synced — the customer stayed on "In Queue".
      expect(currentStep('WAITING', 'IN_SERVICE')).toBe(2);
    });

    it('shows "Ready" once the visit is ready, though the ticket cannot say so', () => {
      expect(currentStep('IN_SERVICE', 'READY_FOR_PICKUP')).toBe(3);
    });

    it('advances with the ticket when the visit lags behind', () => {
      expect(currentStep('IN_SERVICE', 'CHECKED_IN')).toBe(2);
    });

    it('never goes backwards', () => {
      expect(currentStep('CALLED', 'IN_SERVICE')).toBeGreaterThanOrEqual(stepOf('IN_SERVICE'));
    });
  });
});
