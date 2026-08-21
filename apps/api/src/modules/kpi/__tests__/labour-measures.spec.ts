import { describe, it, expect } from 'vitest';
import {
  computeLabourMeasures,
  type Segment,
  type ExclusionSpan,
} from '../engine/labour-measures';

/**
 * CR-2026-090 — labour measures.
 *
 * The distinction under test throughout: JOB time is wall-clock and there is one of
 * it; LABOUR time is per person and there can be more of it than the job lasted. Two
 * technicians working one hour side by side is one hour of job and two of labour.
 *
 * Times are written as HH:MM on a fixed date so the arithmetic is readable.
 */

const T = (hhmm: string) => new Date(`2026-08-21T${hhmm}:00.000Z`);

const seg = (technicianId: string, from: string, to: string | null): Segment => ({
  technicianId,
  startedAt: T(from),
  endedAt: to === null ? null : T(to),
});

const excl = (from: string, to: string | null): ExclusionSpan => ({
  startedAt: T(from),
  endedAt: to === null ? null : T(to),
});

const NOW = T('18:00');

describe('solo job', () => {
  it('active, team and coverage all agree, with no concurrency', () => {
    const m = computeLabourMeasures([seg('marcus', '09:00', '10:30')], [], NOW);

    expect(m.perTechnician).toHaveLength(1);
    expect(m.perTechnician[0].activeMinutes).toBe(90);
    expect(m.teamLabourMinutes).toBe(90);
    expect(m.activeCoverageMinutes).toBe(90);
    expect(m.concurrentAssistMinutes).toBe(0);
    expect(m.isShared).toBe(false);
  });

  it('sums a technician’s separate segments and does not count the gap between them', () => {
    // Worked 9:00-10:00, paused an hour, worked 11:00-11:30. Ninety minutes of
    // labour, not the two and a half hours the clock ran.
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '10:00'), seg('marcus', '11:00', '11:30')],
      [],
      NOW,
    );
    expect(m.perTechnician[0].activeMinutes).toBe(90);
    expect(m.perTechnician[0].segmentCount).toBe(2);
    expect(m.activeCoverageMinutes).toBe(90);
  });

  it('measures an open segment to now, and flags it as still running', () => {
    const m = computeLabourMeasures([seg('marcus', '17:00', null)], [], NOW);
    expect(m.perTechnician[0].activeMinutes).toBe(60);
    expect(m.perTechnician[0].stillActive).toBe(true);
  });

  it('reports nothing for a job with no segments', () => {
    const m = computeLabourMeasures([], [], NOW);
    expect(m.teamLabourMinutes).toBe(0);
    expect(m.activeCoverageMinutes).toBe(0);
    expect(m.technicianCount).toBe(0);
    expect(m.isShared).toBe(false);
  });

  it('ignores a zero-length segment rather than counting it as work', () => {
    const m = computeLabourMeasures([seg('marcus', '09:00', '09:00')], [], NOW);
    expect(m.teamLabourMinutes).toBe(0);
  });
});

describe('shared job', () => {
  it('counts labour per person, not once for the job', () => {
    // Both on it 09:00-10:00. One hour of job, two hours of labour.
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '10:00'), seg('dane', '09:00', '10:00')],
      [],
      NOW,
    );

    expect(m.teamLabourMinutes).toBe(120);
    expect(m.activeCoverageMinutes).toBe(60);
    expect(m.concurrentAssistMinutes).toBe(60);
    expect(m.isShared).toBe(true);
    expect(m.technicianCount).toBe(2);
  });

  it('separates overlapping help from sequential help', () => {
    // Marcus 09:00-11:00; Dane helps 10:00-10:30 only.
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '11:00'), seg('dane', '10:00', '10:30')],
      [],
      NOW,
    );

    expect(m.teamLabourMinutes).toBe(150);
    expect(m.activeCoverageMinutes).toBe(120); // the job was covered for two hours
    expect(m.concurrentAssistMinutes).toBe(30); // half an hour of it by two people
  });

  it('reports no concurrency when the two never overlap', () => {
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '10:00'), seg('dane', '10:00', '11:00')],
      [],
      NOW,
    );

    expect(m.teamLabourMinutes).toBe(120);
    expect(m.activeCoverageMinutes).toBe(120);
    expect(m.concurrentAssistMinutes).toBe(0);
    expect(m.isShared).toBe(true);
  });

  it('handles three technicians overlapping at different depths', () => {
    // marcus 09:00-12:00, dane 10:00-11:00, kemar 10:30-11:30.
    // Two-or-more depth runs 10:00-11:30 = 90 minutes.
    const m = computeLabourMeasures(
      [
        seg('marcus', '09:00', '12:00'),
        seg('dane', '10:00', '11:00'),
        seg('kemar', '10:30', '11:30'),
      ],
      [],
      NOW,
    );

    expect(m.teamLabourMinutes).toBe(180 + 60 + 60);
    expect(m.activeCoverageMinutes).toBe(180);
    expect(m.concurrentAssistMinutes).toBe(90);
    expect(m.technicianCount).toBe(3);
  });

  it('lists technicians by contribution, most first', () => {
    const m = computeLabourMeasures(
      [seg('dane', '10:00', '10:30'), seg('marcus', '09:00', '11:00')],
      [],
      NOW,
    );
    expect(m.perTechnician.map((t) => t.technicianId)).toEqual(['marcus', 'dane']);
  });

  it('reassignment reads as one continuous covered job, two shorter labour records', () => {
    // Marcus starts, is reassigned at 10:00, Dane takes over and finishes at 11:00.
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '10:00'), seg('dane', '10:00', '11:00')],
      [],
      NOW,
    );

    expect(m.activeCoverageMinutes).toBe(120);
    expect(m.perTechnician.map((t) => t.activeMinutes)).toEqual([60, 60]);
    expect(m.concurrentAssistMinutes).toBe(0);
  });
});

describe('exclusions', () => {
  it('deducts an approved job-wide delay from coverage ONCE, not once per technician', () => {
    // Three technicians, 09:00-11:00 each, with a 30-minute approved parts wait.
    // Deducting it per technician would erase 90 minutes for a 30-minute delay.
    const segments: Segment[] = [
      seg('marcus', '09:00', '11:00'),
      seg('dane', '09:00', '11:00'),
      seg('kemar', '09:00', '11:00'),
    ];
    const m = computeLabourMeasures(segments, [excl('10:00', '10:30')], NOW);

    expect(m.activeCoverageMinutes).toBe(120);
    expect(m.excludedCoverageMinutes).toBe(30);
    expect(m.netCoverageMinutes).toBe(90);
  });

  it('does not deduct a delay that falls outside every segment', () => {
    // Pausing closes segments, so an approved delay usually sits in a gap where
    // nobody's clock was running — there is nothing left to deduct.
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '10:00'), seg('marcus', '11:00', '12:00')],
      [excl('10:00', '11:00')],
      NOW,
    );

    expect(m.perTechnician[0].activeMinutes).toBe(120);
    expect(m.excludedCoverageMinutes).toBe(0);
    expect(m.netCoverageMinutes).toBe(120);
  });

  it('deducts a retrospectively approved delay from the segment it overlaps', () => {
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '11:00')],
      [excl('09:30', '10:00')],
      NOW,
    );
    expect(m.perTechnician[0].activeMinutes).toBe(90);
  });

  it('merges overlapping exclusions so the same minutes are never deducted twice', () => {
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '12:00')],
      [excl('10:00', '11:00'), excl('10:30', '11:30')],
      NOW,
    );
    // The union is 10:00-11:30 = 90 minutes, not 60 + 60.
    expect(m.excludedCoverageMinutes).toBe(90);
    expect(m.perTechnician[0].activeMinutes).toBe(90);
  });

  it('never lets an exclusion drive a figure negative', () => {
    const m = computeLabourMeasures(
      [seg('marcus', '09:00', '09:30')],
      [excl('08:00', '12:00')],
      NOW,
    );
    expect(m.perTechnician[0].activeMinutes).toBe(0);
    expect(m.netCoverageMinutes).toBe(0);
  });
});
