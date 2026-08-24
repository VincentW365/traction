import { describe, it, expect, vi } from 'vitest';
import { TechniciansService } from '../technicians.service';

/**
 * CR-2026-035 — getRecommendedTechnicians: skill candidacy (via the engine matcher),
 * load + shift-availability scoring/ranking, bay compatibility, 404.
 */
function build(over: { order?: unknown; technicians?: unknown[]; bays?: unknown[] } = {}) {
  const defaultOrder = {
    id: 'so1',
    items: [{ serviceType: { requiredSkillCode: 'BRK', requiredBayType: null } }],
    serviceVisit: { siteId: 'site1' },
  };
  const technicians = over.technicians ?? [
    { id: 'tA', employeeCode: 'E-A', userAccount: { fullName: 'Tech A' }, skills: [{ skillCode: 'BRK' }], assignments: [], availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }] },
    { id: 'tB', employeeCode: 'E-B', userAccount: { fullName: 'Tech B' }, skills: [{ skillCode: 'BRK' }], assignments: [{ id: 'a1', serviceOrder: { status: 'IN_PROGRESS' } }], availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }] },
    { id: 'tC', employeeCode: 'E-C', userAccount: { fullName: 'Tech C' }, skills: [{ skillCode: 'OIL' }], assignments: [], availability: [] },
  ];
  const bays = over.bays ?? [{ id: 'b1', code: 'B1', bayType: 'STANDARD' }, { id: 'b2', code: 'B2', bayType: 'HEAVY' }];
  const prisma: any = {
    serviceOrder: { findUnique: vi.fn(async () => ('order' in over ? over.order : defaultOrder)) },
    technician: { findMany: vi.fn(async () => technicians) },
    workBay: { findMany: vi.fn(async () => bays) },
  };
  const audit = { log: vi.fn() };
  return { service: new TechniciansService(prisma as any, audit as any), prisma };
}

describe('TechniciansService.getRecommendedTechnicians (CR-2026-035)', () => {
  it('returns only techs with ALL required skills, ranked (idle before loaded), with score breakdown', async () => {
    const r = await build().service.getRecommendedTechnicians('so1');
    expect(r.technicians.map((t: any) => t.technicianId)).toEqual(['tA', 'tB']); // tC has no BRK skill
    expect(r.technicians[0].openAssignments).toBe(0);
    expect(r.technicians[0].score).toBeGreaterThan(r.technicians[1].score);
    expect(r.technicians[0].scoreBreakdown).toMatchObject({ base: 100, availabilityBonus: 50 });
    expect(r.requiredSkillCodes).toEqual(['BRK']);
  });

  it('a technician whose only job waits for parts is dispatchable (CR-2026-098b)', async () => {
    // A held job (WAITING_PARTS/PAUSED/WAITING_CUSTOMER) is an idle bench, not
    // active load: reduced penalty, still available for new work.
    const h = build({
      technicians: [
        { id: 'held', employeeCode: 'E-H', userAccount: { fullName: 'Held' }, skills: [{ skillCode: 'BRK' }], assignments: [{ id: 'h1', serviceOrder: { status: 'WAITING_PARTS' } }], availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }] },
        { id: 'busy', employeeCode: 'E-B', userAccount: { fullName: 'Busy' }, skills: [{ skillCode: 'BRK' }], assignments: [{ id: 'b1', serviceOrder: { status: 'IN_PROGRESS' } }], availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }] },
      ],
    });
    const res = await h.service.getRecommendedTechnicians('so1');
    const held = res.technicians.find((r: any) => r.technicianId === 'held');
    const busy = res.technicians.find((r: any) => r.technicianId === 'busy');
    expect(held.available).toBe(true);
    expect(held.heldAssignments).toBe(1);
    expect(held.activeAssignments).toBe(0);
    expect(busy.available).toBe(false);
    expect(held.score).toBeGreaterThan(busy.score);
  });

  it('ranks AVAILABLE + idle above ABSENT + loaded', async () => {
    const r = await build({
      technicians: [
        { id: 'busy', employeeCode: 'E-1', userAccount: { fullName: 'Busy' }, skills: [{ skillCode: 'BRK' }], assignments: [{ id: 'x', serviceOrder: { status: 'IN_PROGRESS' } }], availability: [{ status: 'ABSENT', shiftStart: '', shiftEnd: '' }] },
        { id: 'free', employeeCode: 'E-2', userAccount: { fullName: 'Free' }, skills: [{ skillCode: 'BRK' }], assignments: [], availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }] },
      ],
    }).service.getRecommendedTechnicians('so1');
    expect(r.technicians[0].technicianId).toBe('free');
    expect(r.technicians[1].technicianId).toBe('busy');
  });

  it('compatibleBays = all active bays when no bay type required; filtered when required', async () => {
    const unconstrained = await build().service.getRecommendedTechnicians('so1');
    expect(unconstrained.compatibleBays.map((b: any) => b.id)).toEqual(['b1', 'b2']);

    const constrained = await build({
      order: { id: 'so1', items: [{ serviceType: { requiredSkillCode: 'BRK', requiredBayType: 'HEAVY' } }], serviceVisit: { siteId: 'site1' } },
    }).service.getRecommendedTechnicians('so1');
    expect(constrained.compatibleBays.map((b: any) => b.id)).toEqual(['b2']);
  });

  it('throws 404 when the service order is missing', async () => {
    await expect(build({ order: null }).service.getRecommendedTechnicians('nope')).rejects.toThrow(/not found/i);
  });
});
