/**
 * ETA Calculator
 *
 * Phase 1: Sequential sum — assumes single-track processing.
 * etaStartAt = now + sum of durations for all visits ranked ahead.
 * etaCompleteAt = etaStartAt + own service duration.
 *
 * Phase 2 will upgrade to resource-path-specific ETA.
 */

export function calculateEta(
  visitDurationMinutes: number,
  minutesAhead: number,
  now: Date,
): { etaStartAt: Date; etaCompleteAt: Date } {
  const etaStartAt = new Date(now.getTime() + minutesAhead * 60_000);
  const etaCompleteAt = new Date(
    etaStartAt.getTime() + visitDurationMinutes * 60_000,
  );
  return { etaStartAt, etaCompleteAt };
}
