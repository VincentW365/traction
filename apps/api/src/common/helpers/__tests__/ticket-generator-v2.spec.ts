import { describe, it, expect } from 'vitest';
import {
  buildTicketIdentifiers,
  resolveBusinessDate,
  formatBusinessDateCompact,
  deriveLocationCode,
  isValidLocationCode,
  normaliseTicketSearch,
} from '../ticket-generator-v2';

/**
 * CR-2026-089 — queue ticket numbering v2.
 *
 *   Full reference    B01-260820-003
 *   Customer number   B01-003
 */

const JAMAICA = 'America/Jamaica';
const bd = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('ticket identifiers', () => {
  it('builds the full reference and the customer number', () => {
    const ids = buildTicketIdentifiers('B01', bd('2026-08-20'), 3);
    expect(ids.ticketReference).toBe('B01-260820-003');
    expect(ids.displayTicketNumber).toBe('B01-003');
    expect(ids.dailySequence).toBe(3);
  });

  it('produces sequence 001 for the first ticket of a business day', () => {
    expect(buildTicketIdentifiers('B01', bd('2026-08-20'), 1).ticketReference).toBe(
      'B01-260820-001',
    );
  });

  it('produces 002 for the second', () => {
    expect(buildTicketIdentifiers('B01', bd('2026-08-20'), 2).displayTicketNumber).toBe(
      'B01-002',
    );
  });

  it('lets two locations both issue 001 on the same date', () => {
    const a = buildTicketIdentifiers('B01', bd('2026-08-20'), 1);
    const b = buildTicketIdentifiers('B02', bd('2026-08-20'), 1);
    expect(a.ticketReference).toBe('B01-260820-001');
    expect(b.ticketReference).toBe('B02-260820-001');
    expect(a.ticketReference).not.toBe(b.ticketReference);
  });

  it('expands past 999 rather than wrapping or failing', () => {
    // Three digits is a MINIMUM width, not a limit. Wrapping to 001 would make two
    // different visits indistinguishable; rejecting would stop the front desk dead.
    expect(buildTicketIdentifiers('B01', bd('2026-08-20'), 999).displayTicketNumber).toBe(
      'B01-999',
    );
    expect(buildTicketIdentifiers('B01', bd('2026-08-20'), 1000).displayTicketNumber).toBe(
      'B01-1000',
    );
    expect(buildTicketIdentifiers('B01', bd('2026-08-20'), 1001).ticketReference).toBe(
      'B01-260820-1001',
    );
  });

  it('drops QTK, BERT and the four-digit year', () => {
    const ref = buildTicketIdentifiers('B01', bd('2026-08-20'), 3).ticketReference;
    expect(ref).not.toMatch(/QTK/);
    expect(ref).not.toMatch(/BERT/);
    expect(ref).not.toMatch(/2026/);
    // Comfortably shorter than QTK-BERT-01-20260820-0003.
    expect(ref.length).toBeLessThan('QTK-BERT-01-20260820-0003'.length);
  });

  it('uppercases the location code', () => {
    expect(buildTicketIdentifiers('b01', bd('2026-08-20'), 1).ticketReference).toBe(
      'B01-260820-001',
    );
  });

  it('encodes nothing that could change or expose the customer', () => {
    // No vehicle class, initials, plate, service, technician, bay, rank or status:
    // all of those move, and a moving identifier is not an identifier.
    const ref = buildTicketIdentifiers('B01', bd('2026-08-20'), 7).ticketReference;
    expect(ref).toBe('B01-260820-007');
    expect(ref).toMatch(/^[A-Z0-9]{2,4}-\d{6}-\d{3,}$/);
  });
});

describe('Jamaica business date', () => {
  it('uses the site timezone, not the server date', () => {
    // 02:00 UTC on the 21st is still 21:00 on the 20th in Jamaica (UTC-5).
    // The old generator printed the site-local date but bucketed the sequence on
    // the database's CURRENT_DATE, so for five hours every evening the two
    // disagreed and the reset did not line up with the printed date.
    const late = new Date('2026-08-21T02:00:00.000Z');
    expect(formatBusinessDateCompact(resolveBusinessDate(late, JAMAICA))).toBe('260820');
  });

  it('rolls over at Jamaica midnight, not UTC midnight', () => {
    const beforeLocalMidnight = new Date('2026-08-21T04:59:00.000Z'); // 23:59 local
    const afterLocalMidnight = new Date('2026-08-21T05:01:00.000Z'); // 00:01 local
    expect(formatBusinessDateCompact(resolveBusinessDate(beforeLocalMidnight, JAMAICA))).toBe('260820');
    expect(formatBusinessDateCompact(resolveBusinessDate(afterLocalMidnight, JAMAICA))).toBe('260821');
  });

  it('UTC midnight alone does not start a new Jamaica business day', () => {
    const justAfterUtcMidnight = new Date('2026-08-21T00:30:00.000Z'); // 19:30 local, 20th
    expect(formatBusinessDateCompact(resolveBusinessDate(justAfterUtcMidnight, JAMAICA))).toBe(
      '260820',
    );
  });

  it('returns a date-only value that round-trips through a DATE column', () => {
    const d = resolveBusinessDate(new Date('2026-08-21T02:00:00.000Z'), JAMAICA);
    expect(d.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });
});

describe('location codes', () => {
  it('accepts 2-4 uppercase alphanumerics', () => {
    for (const c of ['B01', 'B02', 'HAG', 'MOB', 'AB', 'AB12']) {
      expect(isValidLocationCode(c)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const c of ['b01', 'B', 'ABCDE', 'B 1', 'B-1', '', null, undefined]) {
      expect(isValidLocationCode(c as string)).toBe(false);
    }
  });

  it('derives a sensible default from an existing site code', () => {
    expect(deriveLocationCode('BERT-01')).toBe('B01');
    expect(deriveLocationCode('BERT-02')).toBe('B02');
  });

  it('always derives something usable', () => {
    expect(isValidLocationCode(deriveLocationCode('MONTEGO'))).toBe(true);
    expect(isValidLocationCode(deriveLocationCode('X'))).toBe(true);
  });

  it('a code change cannot alter references already issued', () => {
    // The code is snapshotted onto the ticket, so rebuilding an old reference from
    // a NEW code is not something the system ever does; historical references are
    // read from the stored value.
    const issued = buildTicketIdentifiers('B01', bd('2026-08-20'), 5);
    const renamed = buildTicketIdentifiers('HAG', bd('2026-08-20'), 5);
    expect(issued.ticketReference).toBe('B01-260820-005');
    expect(renamed.ticketReference).toBe('HAG-260820-005');
    expect(issued.locationCodeSnapshot).toBe('B01');
  });
});

describe('search normalisation', () => {
  it('resolves a reference typed with or without hyphens, in any case', () => {
    const canonical = normaliseTicketSearch('B01-260820-003');
    expect(normaliseTicketSearch('B01260820003')).toBe(canonical);
    expect(normaliseTicketSearch('b01-260820-003')).toBe(canonical);
    expect(normaliseTicketSearch('  B01 260820 003 ')).toBe(canonical);
  });

  it('normalises the short customer number too', () => {
    expect(normaliseTicketSearch('B01-003')).toBe(normaliseTicketSearch('b01003'));
  });

  it('leaves a legacy reference searchable', () => {
    expect(normaliseTicketSearch('QTK-BERT-01-20260820-0003')).toBe(
      'QTKBERT01202608200003',
    );
  });
});
