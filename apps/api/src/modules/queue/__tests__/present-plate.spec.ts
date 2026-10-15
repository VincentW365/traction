import { describe, it, expect } from 'vitest';
import { presentPlate, type DisplayBoardConfig } from '../queue.service';

/**
 * CR-2026-118 §5 — the registration as the lobby screen shows it.
 *
 * Two promises worth testing: the screen never invents a plate, and the mask
 * leaves enough to recognise your own car and not enough to read someone else's.
 */
const SHOW: DisplayBoardConfig = { showPlates: true, maskPlates: false, readyHours: 4 };
const MASK: DisplayBoardConfig = { showPlates: true, maskPlates: true, readyHours: 4 };
const HIDE: DisplayBoardConfig = { showPlates: false, maskPlates: false, readyHours: 4 };

describe('a plate is shown as recorded, tidied', () => {
  it('upper-cases and collapses spacing so one car reads one way', () => {
    expect(presentPlate('8376 jz', SHOW)).toBe('8376 JZ');
    expect(presentPlate('  8376jz ', SHOW)).toBe('8376JZ');
    expect(presentPlate('8376   JZ', SHOW)).toBe('8376 JZ');
  });

  it('drops punctuation that is not part of a registration', () => {
    expect(presentPlate('8376-JZ', SHOW)).toBe('8376JZ');
  });

  it('never fabricates one', () => {
    // The screen shows a fallback for null; it must not show "" or "UNKNOWN".
    expect(presentPlate(null, SHOW)).toBeNull();
    expect(presentPlate(undefined, SHOW)).toBeNull();
    expect(presentPlate('   ', SHOW)).toBeNull();
    expect(presentPlate('---', SHOW)).toBeNull();
  });
});

describe('masking', () => {
  it('keeps the last three characters and hides the rest', () => {
    expect(presentPlate('8376JZ', MASK)).toBe('•••6JZ');
    expect(presentPlate('1234 CD', MASK)).toBe('•••4CD'); // 6 chars: three hidden, three kept
  });

  it('does not reveal a short plate in full', () => {
    expect(presentPlate('ABC', MASK)).toBe('ABC'); // nothing left to hide, nothing to invent
    expect(presentPlate('AB', MASK)).toBe('AB');
  });

  it('still shows nothing for a missing plate', () => {
    expect(presentPlate(null, MASK)).toBeNull();
  });
});

describe('plates switched off', () => {
  it('shows nothing, whatever is recorded', () => {
    expect(presentPlate('8376JZ', HIDE)).toBeNull();
  });
});
