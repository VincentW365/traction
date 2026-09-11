/**
 * CR-2026-105b — the ONE authoritative Estimated-Completion model (pure).
 *
 * Deterministic, per docs/08 §11 (Phase-1 method): project each waiting visit onto
 * the earliest-free service position ("track"), after the in-service visits ahead
 * of it, using planned durations. No I/O; the SchedulingService supplies inputs and
 * persists outputs after ranking.
 *
 * FIFO-first guardrail (CR-2026-099b, CLAUDE.md §5): this model READS the ranked
 * positions and NEVER produces anything the ranker consumes. `position` comes in;
 * times go out. It must not be handed `queueRank`, `overrideRankPosition`,
 * `checkinSequence` or `blockedReason` to write.
 */

import type { EtaModelConfig } from './eta.config';

export type InServiceStage = 'IN_PROGRESS' | 'HOLD' | 'QC';

export interface EtaInServiceVisit {
  serviceVisitId: string;
  /** Wall-clock start of the current attempt (min `ServiceOrder.startedAt`); `now` if not yet started. */
  startedAt: Date;
  plannedMinutes: number;
  /** Sum of CLOSED pause intervals on the visit's live orders, in minutes. */
  closedPauseMinutes: number;
  /** Start of the open pause/hold, when the job is currently stopped. */
  openPauseStartedAt: Date | null;
  stage: InServiceStage;
}

export interface EtaWaitingVisit {
  serviceVisitId: string;
  /** Ranked position (1 = next). `null` = blocked / no position → no time is projected. */
  position: number | null;
  plannedMinutes: number;
  /** A job sent back from QC: only part of the planned time is assumed to remain. */
  isRework?: boolean;
}

export type EtaBasis = 'IN_SERVICE' | 'HOLD' | 'QC' | 'QUEUED' | 'BLOCKED';

export interface EtaVisitResult {
  serviceVisitId: string;
  estimatedStartAt: Date | null;
  estimatedCompleteAt: Date | null;
  basis: EtaBasis;
  /** Remaining minutes at `now` for in-service visits; projected duration for queued ones. */
  remainingMinutes: number | null;
}

const MS = 60_000;

/**
 * Pure: planned minutes for a visit from the best available source, first hit wins:
 *  1. a KPI standard already fixed for the job (vehicle-class aware, CR-2026-088);
 *  2. Σ `ServiceOrderItem.estimateMinutes` (populated at order creation);
 *  3. Σ `ServiceType.baseDurationMinutes` on order items;
 *  4. Σ `ServiceType.baseDurationMinutes × qty` on appointment services;
 *  5. the configured default (management's 80 minutes).
 */
export function resolvePlannedMinutes(
  input: {
    kpiStandardMinutes?: number | null;
    orderItems?: Array<{ estimateMinutes?: number | null; baseDurationMinutes?: number | null }>;
    appointmentServices?: Array<{ baseDurationMinutes?: number | null; qty?: number | null }>;
  },
  defaultMinutes: number,
): number {
  if (input.kpiStandardMinutes && input.kpiStandardMinutes > 0) return input.kpiStandardMinutes;

  const items = input.orderItems ?? [];
  const estimate = items.reduce((s, i) => s + (i.estimateMinutes && i.estimateMinutes > 0 ? i.estimateMinutes : 0), 0);
  if (estimate > 0) return estimate;

  const base = items.reduce((s, i) => s + (i.baseDurationMinutes && i.baseDurationMinutes > 0 ? i.baseDurationMinutes : 0), 0);
  if (base > 0) return base;

  const booked = (input.appointmentServices ?? []).reduce(
    (s, a) => s + (a.baseDurationMinutes && a.baseDurationMinutes > 0 ? a.baseDurationMinutes * Math.max(1, a.qty ?? 1) : 0),
    0,
  );
  if (booked > 0) return booked;

  return defaultMinutes;
}

/** Minutes of work already done on an in-service visit, holds excluded (docs/114 time model). */
export function workedMinutes(v: EtaInServiceVisit, now: Date): number {
  const elapsed = Math.max(0, (now.getTime() - v.startedAt.getTime()) / MS);
  const openPause = v.openPauseStartedAt ? Math.max(0, (now.getTime() - v.openPauseStartedAt.getTime()) / MS) : 0;
  return Math.max(0, elapsed - v.closedPauseMinutes - openPause);
}

function inServiceResult(v: EtaInServiceVisit, now: Date, cfg: EtaModelConfig): EtaVisitResult {
  if (v.stage === 'QC') {
    return {
      serviceVisitId: v.serviceVisitId,
      estimatedStartAt: v.startedAt,
      estimatedCompleteAt: new Date(now.getTime() + cfg.qcMinutes * MS),
      basis: 'QC',
      remainingMinutes: cfg.qcMinutes,
    };
  }
  // Held clock (CR-2026-105 assumption 9): while a hold is open the remaining work
  // does not shrink; the completion is republished from `now` on every recompute
  // and read as DELAYED until the job resumes.
  const remaining = Math.max(cfg.minRemainingMinutes, v.plannedMinutes - workedMinutes(v, now));
  return {
    serviceVisitId: v.serviceVisitId,
    estimatedStartAt: v.startedAt,
    estimatedCompleteAt: new Date(now.getTime() + remaining * MS),
    basis: v.stage === 'HOLD' ? 'HOLD' : 'IN_SERVICE',
    remainingMinutes: remaining,
  };
}

/**
 * Pure: project every visit at a site.
 *
 * Tracks = max(configured capacity, visits actually in service) — reality beats
 * configuration: if three cars are being worked on, there are three positions.
 * Each in-service visit holds its track until its projected completion; free
 * tracks are free from `now`. Waiting visits are placed in ranked order onto the
 * earliest-free track (start = max(now, freeAt) + transition overhead).
 */
export function computeSiteEta(
  now: Date,
  cfg: EtaModelConfig,
  inService: EtaInServiceVisit[],
  waiting: EtaWaitingVisit[],
): EtaVisitResult[] {
  const results: EtaVisitResult[] = inService.map((v) => inServiceResult(v, now, cfg));

  const trackCount = Math.max(1, cfg.capacity, inService.length);
  const tracks: number[] = results.map((r) => r.estimatedCompleteAt?.getTime() ?? now.getTime());
  while (tracks.length < trackCount) tracks.push(now.getTime());

  const ranked = waiting
    .filter((w): w is EtaWaitingVisit & { position: number } => w.position != null)
    .sort((a, b) => a.position - b.position);

  for (const w of ranked) {
    tracks.sort((a, b) => a - b);
    const freeAt = tracks[0];
    const startMs = Math.max(now.getTime(), freeAt) + cfg.transitionOverheadMinutes * MS;
    const planned = w.isRework ? Math.max(cfg.minRemainingMinutes, w.plannedMinutes * cfg.reworkFactor) : w.plannedMinutes;
    const completeMs = startMs + planned * MS;
    tracks[0] = completeMs;
    results.push({
      serviceVisitId: w.serviceVisitId,
      estimatedStartAt: new Date(startMs),
      estimatedCompleteAt: new Date(completeMs),
      basis: 'QUEUED',
      remainingMinutes: planned,
    });
  }

  for (const w of waiting) {
    if (w.position == null) {
      results.push({
        serviceVisitId: w.serviceVisitId,
        estimatedStartAt: null,
        estimatedCompleteAt: null,
        basis: 'BLOCKED',
        remainingMinutes: null,
      });
    }
  }

  return results;
}
