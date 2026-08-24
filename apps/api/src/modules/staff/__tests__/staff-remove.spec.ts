import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { StaffService } from '../staff.service';

/**
 * CR-2026-095 — deleting a deactivated staff member.
 *
 * The line: a person in the shop's OPERATIONAL RECORD is not deletable. Deletion is
 * for accounts that never did anything — created in error, duplicates, hires who
 * never started. Everyone else stays deactivated so history keeps resolving.
 */

const INACTIVE_TECH = {
  id: 'user-1',
  fullName: 'Test Person',
  email: 'test@bert.local',
  roleCode: 'TECHNICIAN',
  status: 'INACTIVE',
  technician: { id: 'tech-1', employeeCode: 'BERT-T99' },
};

function build(overrides: Record<string, any> = {}) {
  const prisma: any = {
    userAccount: {
      findUnique: vi.fn(async () => INACTIVE_TECH),
      delete: vi.fn(async () => ({})),
    },
    technician: { delete: vi.fn(async () => ({})) },
    technicianSkill: { deleteMany: vi.fn(async () => ({})) },
    mechanicDayAvailability: { deleteMany: vi.fn(async () => ({})) },
    technicianAssignment: { count: vi.fn(async () => 0) },
    technicianWorkSegment: { count: vi.fn(async () => 0) },
    kpiDelayEvent: { count: vi.fn(async () => 0) },
    resourceOccupancy: { count: vi.fn(async () => 0) },
    serviceOrder: { count: vi.fn(async () => 0) },
    auditLog: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    ...overrides,
  };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new StaffService(prisma as any, audit as any);
  // findById is the service's own richer lookup; stub it to the fixture.
  vi.spyOn(service, 'findById').mockResolvedValue(
    (overrides.__member ?? INACTIVE_TECH) as never,
  );
  return { service, prisma, audit };
}

describe('staff deletion', () => {
  it('deletes a never-used, deactivated technician entirely', async () => {
    const h = build();
    const r = await h.service.remove('user-1', 'admin-1');

    expect(r.deleted).toBe(true);
    expect(h.prisma.technician.delete).toHaveBeenCalledWith({ where: { id: 'tech-1' } });
    expect(h.prisma.userAccount.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_DELETE' }));
  });

  it('refuses while the account is still ACTIVE — deactivate first', async () => {
    const h = build({ __member: { ...INACTIVE_TECH, status: 'ACTIVE' } });
    await expect(h.service.remove('user-1', 'admin-1')).rejects.toThrow(/deactivate/i);
    expect(h.prisma.userAccount.delete).not.toHaveBeenCalled();
  });

  it('refuses anyone with recorded work, naming what blocks it', async () => {
    const h = build({
      technicianAssignment: { count: vi.fn(async () => 41) },
      technicianWorkSegment: { count: vi.fn(async () => 12) },
    });
    const err = await h.service.remove('user-1', 'admin-1').catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/41 work assignment/);
    expect(err.message).toMatch(/12 recorded work segment/);
    expect(err.message).toMatch(/stay deactivated/i);
    expect(h.prisma.userAccount.delete).not.toHaveBeenCalled();
  });

  it('refuses anyone who ever took an audited action', async () => {
    const h = build({ auditLog: { count: vi.fn(async () => 7) } });
    await expect(h.service.remove('user-1', 'admin-1')).rejects.toThrow(/7 audited action/);
  });

  it('a QC assignment blocks deletion even with no ordinary assignments', async () => {
    const h = build({ serviceOrder: { count: vi.fn(async () => 2) } });
    await expect(h.service.remove('user-1', 'admin-1')).rejects.toThrow(/quality-check/i);
  });

  it('an unforeseen foreign key refuses cleanly rather than half-deleting', async () => {
    const h = build({
      userAccount: {
        findUnique: vi.fn(async () => INACTIVE_TECH),
        delete: vi.fn(async () => {
          const e: any = new Error('FK violation');
          e.code = 'P2003';
          throw e;
        }),
      },
    });
    await expect(h.service.remove('user-1', 'admin-1')).rejects.toThrow(/still referenced/i);
  });

  it('a plain non-technician account deletes without touching technician tables', async () => {
    const h = build({ __member: { ...INACTIVE_TECH, technician: null } });
    await h.service.remove('user-1', 'admin-1');
    expect(h.prisma.technician.delete).not.toHaveBeenCalled();
    expect(h.prisma.userAccount.delete).toHaveBeenCalled();
  });
});
