import { describe, it, expect } from 'vitest';
import { calculateFifoPositions, FifoTicket } from '../engine/fifo-position.calculator';

function ticket(seq: number, overrides?: Partial<FifoTicket>): FifoTicket {
  return {
    queueTicketId: `t${seq}`,
    serviceVisitId: `v${seq}`,
    checkinSequence: seq,
    displayStatus: 'WAITING',
    overrideActive: false,
    overrideRankPosition: null,
    blockedReason: null,
    ...overrides,
  };
}

describe('calculateFifoPositions', () => {
  it('assigns positions in check-in order (pure FIFO)', () => {
    const tickets = [ticket(1), ticket(2), ticket(3)];
    const results = calculateFifoPositions(tickets);
    expect(results[0]).toMatchObject({ queueTicketId: 't1', fifoPosition: 1 });
    expect(results[1]).toMatchObject({ queueTicketId: 't2', fifoPosition: 2 });
    expect(results[2]).toMatchObject({ queueTicketId: 't3', fifoPosition: 3 });
  });

  it('blocked tickets get null position (step aside)', () => {
    const tickets = [
      ticket(1),
      ticket(2, { displayStatus: 'BLOCKED', blockedReason: 'Missing parts' }),
      ticket(3),
    ];
    const results = calculateFifoPositions(tickets);
    const positioned = results.filter((r) => r.fifoPosition !== null);
    const blocked = results.filter((r) => r.fifoPosition === null);

    expect(positioned).toHaveLength(2);
    expect(positioned[0]).toMatchObject({ queueTicketId: 't1', fifoPosition: 1 });
    expect(positioned[1]).toMatchObject({ queueTicketId: 't3', fifoPosition: 2 });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ queueTicketId: 't2', blockedReason: 'Missing parts' });
  });

  it('pinned override gets requested position', () => {
    const tickets = [
      ticket(1),
      ticket(2),
      ticket(3, { overrideActive: true, overrideRankPosition: 1 }),
    ];
    const results = calculateFifoPositions(tickets);
    const positioned = results.filter((r) => r.fifoPosition !== null);

    expect(positioned[0]).toMatchObject({ queueTicketId: 't3', fifoPosition: 1, isOverride: true });
    expect(positioned[1]).toMatchObject({ queueTicketId: 't1', fifoPosition: 2, isOverride: false });
    expect(positioned[2]).toMatchObject({ queueTicketId: 't2', fifoPosition: 3, isOverride: false });
  });

  it('empty queue returns empty array', () => {
    expect(calculateFifoPositions([])).toEqual([]);
  });

  it('single ticket gets position 1', () => {
    const results = calculateFifoPositions([ticket(1)]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ fifoPosition: 1 });
  });

  it('all blocked returns all null positions', () => {
    const tickets = [
      ticket(1, { displayStatus: 'BLOCKED', blockedReason: 'No tech' }),
      ticket(2, { displayStatus: 'BLOCKED', blockedReason: 'No parts' }),
    ];
    const results = calculateFifoPositions(tickets);
    expect(results.every((r) => r.fifoPosition === null)).toBe(true);
  });

  it('appointment and walk-in treated equally (FIFO only)', () => {
    // Walk-in checked in first (seq 1), appointment checked in second (seq 2)
    // FIFO: walk-in is position 1, appointment is position 2
    const tickets = [ticket(1), ticket(2)];
    const results = calculateFifoPositions(tickets);
    expect(results[0]).toMatchObject({ queueTicketId: 't1', fifoPosition: 1 });
    expect(results[1]).toMatchObject({ queueTicketId: 't2', fifoPosition: 2 });
  });

  it('two overrides at same position: first listed wins', () => {
    const tickets = [
      ticket(1),
      ticket(2, { overrideActive: true, overrideRankPosition: 1 }),
      ticket(3, { overrideActive: true, overrideRankPosition: 1 }),
    ];
    const results = calculateFifoPositions(tickets);
    const positioned = results.filter((r) => r.fifoPosition !== null);

    // Both overrides want position 1; first gets 1, second gets 2, regular gets 3
    expect(positioned[0]).toMatchObject({ queueTicketId: 't2', fifoPosition: 1 });
    expect(positioned[1]).toMatchObject({ queueTicketId: 't3', fifoPosition: 2 });
    expect(positioned[2]).toMatchObject({ queueTicketId: 't1', fifoPosition: 3 });
  });

  it('blocked skip: position 1 blocked, position 2 becomes effective #1', () => {
    const tickets = [
      ticket(1, { displayStatus: 'BLOCKED', blockedReason: 'No parts' }),
      ticket(2),
      ticket(3),
    ];
    const results = calculateFifoPositions(tickets);
    const positioned = results.filter((r) => r.fifoPosition !== null);
    expect(positioned[0]).toMatchObject({ queueTicketId: 't2', fifoPosition: 1 });
    expect(positioned[1]).toMatchObject({ queueTicketId: 't3', fifoPosition: 2 });
  });
});
