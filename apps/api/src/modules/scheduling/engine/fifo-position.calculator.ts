/**
 * FIFO Position Calculator (v2)
 *
 * Replaces the 6-stage weighted-scoring pipeline with simple FIFO ordering.
 * Position is determined by check-in order (checkinSequence), with two modifications:
 *   1. Blocked tickets step aside (position = null)
 *   2. Pinned overrides are inserted at their requested position
 *
 * This is a pure function — no database access, no side effects.
 */

export interface FifoTicket {
  queueTicketId: string;
  serviceVisitId: string;
  checkinSequence: number;
  displayStatus: string;
  overrideActive: boolean;
  overrideRankPosition: number | null;
  blockedReason: string | null;
}

export interface FifoResult {
  queueTicketId: string;
  serviceVisitId: string;
  fifoPosition: number | null; // null = blocked (stepped aside)
  displayStatus: string;
  blockedReason: string | null;
  isOverride: boolean;
}

/**
 * Calculate FIFO positions for all active tickets at a site.
 *
 * @param tickets - Active tickets ordered by checkinSequence ASC
 * @returns Positioned tickets: eligible get 1-based positions, blocked get null
 */
export function calculateFifoPositions(
  tickets: FifoTicket[],
): FifoResult[] {
  // Separate into: pinned overrides, eligible (non-blocked), blocked
  const pinned: FifoTicket[] = [];
  const eligible: FifoTicket[] = [];
  const blocked: FifoTicket[] = [];

  for (const ticket of tickets) {
    if (ticket.displayStatus === 'BLOCKED') {
      blocked.push(ticket);
    } else if (
      ticket.overrideActive &&
      ticket.overrideRankPosition != null
    ) {
      pinned.push(ticket);
    } else {
      eligible.push(ticket);
    }
  }

  // Sort pinned by their requested position (lowest first)
  pinned.sort((a, b) => (a.overrideRankPosition ?? 999) - (b.overrideRankPosition ?? 999));

  // Eligible are already in checkinSequence order (from input)

  // Merge: pinned get their requested positions, eligible fill the rest
  const positioned: FifoResult[] = [];
  let eligibleIdx = 0;
  let pinnedIdx = 0;
  let position = 1;

  while (pinnedIdx < pinned.length || eligibleIdx < eligible.length) {
    // Check if a pinned ticket wants this position
    if (
      pinnedIdx < pinned.length &&
      (pinned[pinnedIdx].overrideRankPosition ?? 999) <= position
    ) {
      positioned.push({
        queueTicketId: pinned[pinnedIdx].queueTicketId,
        serviceVisitId: pinned[pinnedIdx].serviceVisitId,
        fifoPosition: position,
        displayStatus: pinned[pinnedIdx].displayStatus,
        blockedReason: null,
        isOverride: true,
      });
      pinnedIdx++;
    } else if (eligibleIdx < eligible.length) {
      positioned.push({
        queueTicketId: eligible[eligibleIdx].queueTicketId,
        serviceVisitId: eligible[eligibleIdx].serviceVisitId,
        fifoPosition: position,
        displayStatus: eligible[eligibleIdx].displayStatus,
        blockedReason: null,
        isOverride: false,
      });
      eligibleIdx++;
    } else {
      // Only pinned left, place them sequentially
      positioned.push({
        queueTicketId: pinned[pinnedIdx].queueTicketId,
        serviceVisitId: pinned[pinnedIdx].serviceVisitId,
        fifoPosition: position,
        displayStatus: pinned[pinnedIdx].displayStatus,
        blockedReason: null,
        isOverride: true,
      });
      pinnedIdx++;
    }
    position++;
  }

  // Blocked tickets: no position
  const blockedResults: FifoResult[] = blocked.map((t) => ({
    queueTicketId: t.queueTicketId,
    serviceVisitId: t.serviceVisitId,
    fifoPosition: null,
    displayStatus: 'BLOCKED',
    blockedReason: t.blockedReason,
    isOverride: false,
  }));

  return [...positioned, ...blockedResults];
}
