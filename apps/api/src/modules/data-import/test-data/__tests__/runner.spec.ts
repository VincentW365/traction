import { describe, it, expect, vi } from 'vitest';
import { planRun, createRun } from '../runner';
import { DEFAULT_SCENARIO_KEYS } from '../scenarios';

/** Read-capable prisma mock whose WRITE paths throw if touched. */
function mockPrisma(over: Record<string, any> = {}): any {
  const writeBoom = vi.fn(async () => {
    throw new Error('UNEXPECTED WRITE');
  });
  return {
    site: { findUnique: vi.fn(async () => ({ id: 'site-1', timezone: 'America/Jamaica' })), findFirst: vi.fn(async () => null) },
    userAccount: { findFirst: vi.fn(async () => ({ id: 'user-1' })) },
    technician: { findFirst: vi.fn(async () => ({ id: 'tech-1' })) },
    workBay: { findFirst: vi.fn(async () => ({ id: 'bay-1' })) },
    serviceType: { findFirst: vi.fn(async () => ({ id: 'svc-1', baseDurationMinutes: 30 })) },
    testDataRun: { findUnique: vi.fn(async () => null), create: writeBoom, update: writeBoom },
    externalSystemRef: { create: writeBoom },
    $transaction: vi.fn(async () => {
      throw new Error('UNEXPECTED $transaction');
    }),
    ...over,
  };
}

describe('planRun (dry-run) performs NO writes', () => {
  it('resolves from reads only; never opens a transaction or creates rows', async () => {
    const prisma = mockPrisma();
    const result = await planRun(prisma, {
      defaultSiteCode: 'BERT-01',
      scenarioKeys: DEFAULT_SCENARIO_KEYS,
      repeat: 1,
      allowEnabled: false,
    });
    expect(result.effectiveKeys).toEqual(DEFAULT_SCENARIO_KEYS);
    expect(result.allowEnabled).toBe(false);
    expect(result.summary.totalRows).toBeGreaterThan(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.testDataRun.create).not.toHaveBeenCalled();
    expect(prisma.externalSystemRef.create).not.toHaveBeenCalled();
  });

  it('drops the transport scenario (with a warning) when no transport-eligible ServiceType exists', async () => {
    const prisma = mockPrisma({
      serviceType: {
        findFirst: vi.fn().mockResolvedValueOnce({ id: 'svc-1', baseDurationMinutes: 30 }).mockResolvedValueOnce(null),
      },
    });
    const result = await planRun(prisma, {
      defaultSiteCode: 'BERT-01',
      scenarioKeys: ['walkin', 'transport'],
      repeat: 1,
      allowEnabled: true,
    });
    expect(result.effectiveKeys).toEqual(['walkin']);
    expect(result.warnings.join(' ')).toMatch(/transport scenario will be SKIPPED/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('createRun refuses a duplicate label BEFORE any transaction', () => {
  it('throws and never opens a transaction', async () => {
    const prisma = mockPrisma({
      testDataRun: { findUnique: vi.fn(async () => ({ id: 'existing-run' })), create: vi.fn(), update: vi.fn() },
    });
    await expect(
      createRun(prisma, { defaultSiteCode: 'BERT-01', label: 'dupe', scenarioKeys: ['walkin'], repeat: 1 }),
    ).rejects.toThrow(/already exists/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
