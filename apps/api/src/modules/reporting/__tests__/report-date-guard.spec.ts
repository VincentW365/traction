import { describe, it, expect, vi } from 'vitest';
import { ReportingController } from '../reporting.controller';

/**
 * CR-2026-100 — regression guard for the report date validation.
 *
 * The CR-2026-099 guard shipped with a broken regex (`/^d{4}-d{2}-d{2}$/`, the
 * backslashes lost in transit) that matched only the literal string
 * "dddd-dd-dd" — so every VALID date was rejected with 400 and the entire
 * Reports page failed to load. No test covered the accept path, which is how
 * it survived. These tests pin both directions.
 */

function build() {
  const reporting = {
    getKpis: vi.fn(async () => []),
  };
  const jobTimes = { getJobTimes: vi.fn(async () => ({ jobs: [], byTechnician: [], summary: {} })) };
  const perfReport = { getReport: vi.fn(async () => ({})) };
  return {
    controller: new ReportingController(reporting as never, jobTimes as never, perfReport as never),
    reporting,
    jobTimes,
  };
}

describe('report date guard (CR-2026-099/100)', () => {
  it('ACCEPTS a real YYYY-MM-DD range — the regression that broke the Reports page', async () => {
    const h = build();
    await h.controller.getKpis('site-1', '2026-08-01', '2026-08-31', undefined);
    expect(h.reporting.getKpis).toHaveBeenCalledWith('site-1', '2026-08-01', '2026-08-31', false);
  });

  it('rejects a malformed date with a plain 400', async () => {
    const h = build();
    await expect(h.controller.getKpis('site-1', 'garbage', '2026-08-31', undefined)).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(h.reporting.getKpis).not.toHaveBeenCalled();
  });

  it('rejects a reversed range', async () => {
    const h = build();
    await expect(
      h.controller.getKpis('site-1', '2026-08-31', '2026-08-01', undefined),
    ).rejects.toThrow(/must not be after/);
  });

  it('rejects a missing siteId', async () => {
    const h = build();
    await expect(h.controller.getKpis('', '2026-08-01', '2026-08-31', undefined)).rejects.toThrow(
      /siteId/,
    );
  });

  it('job-times validates its filter enums as 400s, not Prisma 500s', async () => {
    const h = build();
    await expect(
      h.controller.getJobTimes('site-1', '2026-08-01', '2026-08-31', undefined, 'HATCHBACK'),
    ).rejects.toThrow(/vehicleClass/);
    await expect(
      h.controller.getJobTimes('site-1', '2026-08-01', '2026-08-31', undefined, undefined, 'DRIVE_BY'),
    ).rejects.toThrow(/sourceType/);
    // And a valid call goes through with the filters intact.
    await h.controller.getJobTimes('site-1', '2026-08-01', '2026-08-31', 'tech-1', 'SUV_CLASS', 'WALKIN', 'st-1');
    expect(h.jobTimes.getJobTimes).toHaveBeenCalledWith('site-1', '2026-08-01', '2026-08-31', {
      technicianId: 'tech-1',
      vehicleClass: 'SUV_CLASS',
      sourceType: 'WALKIN',
      serviceTypeId: 'st-1',
    });
  });
});
