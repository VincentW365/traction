import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ResourceAdminService } from '../resource-admin.service';
import { contributesCapacity, isUsableNow } from '../resource-truth-audit.service';

/**
 * CR-2026-108 Stage 5B — the resource registry becomes the source of capacity.
 *
 * The failure this whole stage exists to prevent is a migration quietly turning
 * seventeen unaudited rows into seventeen bookable positions. So the tests below
 * are mostly about things NOT happening: unclassified rows counting for nothing,
 * equipment never inflating a total, a capability never multiplying a position,
 * and none of it reaching a customer.
 */

const SITE = 'site-1';

function build(overrides: Record<string, any> = {}) {
  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ id: SITE })) },
    workResource: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => ({ id: 'res-1', ...data })),
      update: vi.fn(async ({ data }: any) => ({ id: 'res-1', ...data })),
    },
    workBay: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: any) => ({ id: 'bay-1', ...data })),
    },
    workResourceCapability: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    serviceType: { findMany: vi.fn(async () => []) },
    resourceOperationalStatus: { upsert: vi.fn(async () => ({ id: 'ops-1' })) },
    resourceReservation: { count: vi.fn(async () => 0) },
    technicianAssignment: { count: vi.fn(async () => 0) },
    auditLog: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...overrides,
  };
  // Typed parameter on purpose: a zero-arg mock gives calls[0] an empty-tuple type,
  // so `calls[0][0].action` fails to compile.
  const audit = { log: vi.fn(async (_entry: { action: string; [k: string]: unknown }) => ({})) };
  return { service: new ResourceAdminService(prisma as any, audit as any), prisma, audit };
}

/** The vocabulary is read from the data, so tests must seed both halves. */
function withVocabulary(prisma: any, values: string[]) {
  prisma.serviceType.findMany = vi.fn(async () => values.map((v) => ({ requiredBayType: v })));
  prisma.workBay.findMany = vi.fn(async () => []);
}

// ---------------------------------------------------------------------------
// §1 / §12 — unverified is the default, and it is worth ZERO
// ---------------------------------------------------------------------------
describe('§1 — a resource starts unclassified, and unclassified is worth nothing', () => {
  it('a newly created resource is UNVERIFIED, not a work position', async () => {
    const h = build();
    await h.service.create(SITE, { code: 'BAY-9', name: 'New expansion bay', resourceCategory: 'BAY' }, 'user-1');
    expect(h.prisma.workResource.create.mock.calls[0][0].data.capacityRole).toBe('UNVERIFIED');
  });

  it('the migration lands every existing row on UNVERIFIED, so nothing becomes capacity by deploying', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'prisma', 'migrations', '20260916160000_cr_2026_108_resource_capacity_role', 'migration.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "capacity_role" "ResourceCapacityRole" NOT NULL DEFAULT 'UNVERIFIED'/);
    // Additive only: nothing is dropped, renamed, or back-filled into capacity.
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/UPDATE "work_resources"/i);
  });

  it('UNVERIFIED contributes nothing — and neither does PLACEHOLDER or equipment', () => {
    expect(contributesCapacity('UNVERIFIED')).toBe(false);
    expect(contributesCapacity('PLACEHOLDER')).toBe(false);
    // §1 — equipment is a DECISION that it contributes nothing. Same total,
    // different meaning, which is why they are separate values.
    expect(contributesCapacity('SUPPORT_EQUIPMENT')).toBe(false);
    expect(contributesCapacity('PRIMARY_SERVICE_POSITION')).toBe(true);
    expect(contributesCapacity('OVERFLOW_SERVICE_POSITION')).toBe(true);
  });

  it('refuses a role it does not recognise rather than storing a typo', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => ({
      id: 'res-1', siteId: SITE, code: 'BAY-1', isActive: true, retiredAt: null,
      updatedAt: new Date('2026-09-16T10:00:00Z'),
    }));
    await expect(h.service.update('res-1', { capacityRole: 'REAL_GOOD_BAY' }, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ---------------------------------------------------------------------------
// §2 — role and operational status are different questions
// ---------------------------------------------------------------------------
describe('§2 — capacity role and operational status stay separate', () => {
  const primary = { isActive: true, retiredAt: null, schedulingEnabled: true };

  it('a confirmed position under maintenance contributes nothing TODAY but keeps its role', () => {
    expect(isUsableNow({ ...primary, operationalStatus: { status: 'MAINTENANCE' } })).toBe(false);
    // The role is untouched — that is the point. It counts again when it returns.
    expect(contributesCapacity('PRIMARY_SERVICE_POSITION')).toBe(true);
  });

  it('no status row means AVAILABLE, because setStatus only writes on a change', () => {
    expect(isUsableNow({ ...primary, operationalStatus: null })).toBe(true);
  });

  it('retired, deactivated and descheduled all stop it counting', () => {
    expect(isUsableNow({ ...primary, retiredAt: new Date(), operationalStatus: null })).toBe(false);
    expect(isUsableNow({ ...primary, isActive: false, operationalStatus: null })).toBe(false);
    expect(isUsableNow({ ...primary, schedulingEnabled: false, operationalStatus: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 — one status mechanism, not two
// ---------------------------------------------------------------------------
describe('§3 — there is exactly one way to take a resource out of service', () => {
  it('setStatus still owns the operational status table, and Stage 5B added no rival', () => {
    const src = readFileSync(join(__dirname, '..', 'resource-admin.service.ts'), 'utf8');
    const writes = src.match(/resourceOperationalStatus\.(upsert|create|update|delete)/g) ?? [];
    // Exactly the writes setStatus and the create/retire paths already made.
    expect(writes.length).toBeGreaterThan(0);
    // The new Stage 5B methods must not write status at all.
    for (const method of ['async setCapabilities', 'async linkLegacyBay', 'async reconciliation']) {
      const body = src.slice(src.indexOf(method));
      const upToNextMember = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/) + 1);
      expect(upToNextMember).not.toContain('resourceOperationalStatus');
    }
  });
});

// ---------------------------------------------------------------------------
// §5 / §7 — the legacy bridge is manual, exclusive, and destroys nothing
// ---------------------------------------------------------------------------
describe('§5 — linking a resource to its old bay record', () => {
  const RESOURCE = { id: 'res-1', code: 'BAY-1', siteId: SITE, legacyBayId: null };

  it('links when the bay is free, and audits it', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => RESOURCE);
    h.prisma.workBay.findUnique = vi.fn(async () => ({ id: 'bay-1', code: 'BAY-01', siteId: SITE, reconciliationDisposition: 'UNRESOLVED', resource: null }));
    const out = await h.service.linkLegacyBay('res-1', 'bay-1', 'user-1');
    expect(out.changed).toBe(true);
    expect(h.prisma.workResource.update.mock.calls[0][0].data).toEqual({ legacyBayId: 'bay-1' });
    expect(h.audit.log.mock.calls[0][0].action).toBe('RESOURCE_LEGACY_BAY_LINK');
  });

  it('refuses a bay already claimed by another resource — one bay is one position', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => RESOURCE);
    h.prisma.workBay.findUnique = vi.fn(async () => ({
      id: 'bay-1', code: 'BAY-01', siteId: SITE, reconciliationDisposition: 'UNRESOLVED', resource: { code: 'BAY-7' },
    }));
    await expect(h.service.linkLegacyBay('res-1', 'bay-1', 'user-1')).rejects.toBeInstanceOf(ConflictException);
    expect(h.prisma.workResource.update).not.toHaveBeenCalled();
  });

  it('refuses to link across sites', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => RESOURCE);
    h.prisma.workBay.findUnique = vi.fn(async () => ({ id: 'bay-1', code: 'BAY-01', siteId: 'other-site', reconciliationDisposition: 'UNRESOLVED', resource: null }));
    await expect(h.service.linkLegacyBay('res-1', 'bay-1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('unlinks by writing null, and audits that as its own act', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => ({ ...RESOURCE, legacyBayId: 'bay-1' }));
    await h.service.linkLegacyBay('res-1', null, 'user-1');
    expect(h.prisma.workResource.update.mock.calls[0][0].data).toEqual({ legacyBayId: null });
    expect(h.audit.log.mock.calls[0][0].action).toBe('RESOURCE_LEGACY_BAY_UNLINK');
  });

  it('§7 — linking touches nothing but the pointer: no assignment or history is rewritten', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => RESOURCE);
    h.prisma.workBay.findUnique = vi.fn(async () => ({ id: 'bay-1', code: 'BAY-01', siteId: SITE, reconciliationDisposition: 'UNRESOLVED', resource: null }));
    await h.service.linkLegacyBay('res-1', 'bay-1', 'user-1');
    expect(Object.keys(h.prisma.workResource.update.mock.calls[0][0].data)).toEqual(['legacyBayId']);
  });

  it('§5 — the code is never used to guess a match', () => {
    const src = readFileSync(join(__dirname, '..', 'resource-admin.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('async linkLegacyBay'));
    const method = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
    // The bay is found by the id the caller chose. A lookup by code would be the
    // inference the CR forbids; comparing codes for an error message is not.
    expect(method).toMatch(/workBay\.findUnique\(\{\s*where:\s*\{\s*id:\s*legacyBayId/);
    expect(method).not.toContain('siteId_code');
    expect(method).not.toMatch(/code:\s*\{\s*(equals|contains|startsWith)/);
  });
});

// ---------------------------------------------------------------------------
// A bay is resolved by a link OR by being accounted for
// ---------------------------------------------------------------------------
describe('recording what happened to a legacy bay', () => {
  const BAY = {
    id: 'bay-1', code: 'BAY-01', reconciliationDisposition: 'UNRESOLVED',
    dispositionNote: null, resource: null, _count: { assignments: 39 },
  };

  it('records the disposition with a note, an actor and a timestamp', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => BAY);
    const out = await h.service.setLegacyBayDisposition(
      'bay-1', { disposition: 'HISTORICAL_ONLY', note: 'Demolished in the 2026 expansion.' }, 'user-1',
    );
    expect(out.changed).toBe(true);
    const data = h.prisma.workBay.update.mock.calls[0][0].data;
    expect(data.reconciliationDisposition).toBe('HISTORICAL_ONLY');
    expect(data.dispositionNote).toBe('Demolished in the 2026 expansion.');
    expect(data.dispositionedByUserId).toBe('user-1');
    expect(data.dispositionedAt).toBeInstanceOf(Date);
    expect(h.audit.log.mock.calls[0][0].action).toBe('LEGACY_BAY_DISPOSITION');
  });

  it('never touches assignments, status or anything else on the bay', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => BAY);
    await h.service.setLegacyBayDisposition('bay-1', { disposition: 'RETIRED', note: 'Taken out of service.' }, 'user-1');
    expect(Object.keys(h.prisma.workBay.update.mock.calls[0][0].data).sort()).toEqual([
      'dispositionNote', 'dispositionedAt', 'dispositionedByUserId', 'reconciliationDisposition',
    ]);
  });

  it('records the historical job count in the audit entry rather than changing it', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => BAY);
    await h.service.setLegacyBayDisposition('bay-1', { disposition: 'REPLACED', note: 'Floor reorganised.' }, 'user-1');
    expect(h.audit.log.mock.calls[0][0].afterJson).toMatchObject({ historicalAssignments: 39 });
  });

  it('demands a reason — a disposition without one is not a record of anything', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => BAY);
    await expect(h.service.setLegacyBayDisposition('bay-1', { disposition: 'RETIRED' }, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      h.service.setLegacyBayDisposition('bay-1', { disposition: 'RETIRED', note: '   ' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.workBay.update).not.toHaveBeenCalled();
  });

  it('refuses a disposition it does not recognise', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => BAY);
    await expect(
      h.service.setLegacyBayDisposition('bay-1', { disposition: 'PROBABLY_GONE', note: 'x' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /** Two answers to one question, and the next reader has to guess which won. */
  it('refuses to disposition a bay that is already linked', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => ({ ...BAY, resource: { code: 'BAY-1' } }));
    await expect(
      h.service.setLegacyBayDisposition('bay-1', { disposition: 'RETIRED', note: 'Gone.' }, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to link a bay that was recorded as history, rather than silently clearing it', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => ({ id: 'res-1', code: 'BAY-1', siteId: SITE, legacyBayId: null }));
    h.prisma.workBay.findUnique = vi.fn(async () => ({
      id: 'bay-1', code: 'BAY-01', siteId: SITE, reconciliationDisposition: 'HISTORICAL_ONLY', resource: null,
    }));
    await expect(h.service.linkLegacyBay('res-1', 'bay-1', 'user-1')).rejects.toBeInstanceOf(ConflictException);
    expect(h.prisma.workResource.update).not.toHaveBeenCalled();
  });

  it('allows UNRESOLVED back without a note, so a mistake can be undone', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => ({
      ...BAY, reconciliationDisposition: 'RETIRED', dispositionNote: 'Gone.',
    }));
    await h.service.setLegacyBayDisposition('bay-1', { disposition: 'UNRESOLVED' }, 'user-1');
    const data = h.prisma.workBay.update.mock.calls[0][0].data;
    expect(data.reconciliationDisposition).toBe('UNRESOLVED');
    expect(data.dispositionedAt).toBeNull();
    expect(data.dispositionedByUserId).toBeNull();
  });

  it('does nothing and audits nothing when the disposition is unchanged', async () => {
    const h = build();
    h.prisma.workBay.findUnique = vi.fn(async () => ({
      ...BAY, reconciliationDisposition: 'RETIRED', dispositionNote: 'Gone.',
    }));
    const out = await h.service.setLegacyBayDisposition('bay-1', { disposition: 'RETIRED', note: 'Gone.' }, 'user-1');
    expect(out.changed).toBe(false);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('throws NotFound for a bay that does not exist', async () => {
    const h = build();
    await expect(
      h.service.setLegacyBayDisposition('nope', { disposition: 'RETIRED', note: 'x' }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// §8 / §9 — capabilities describe versatility, never quantity
// ---------------------------------------------------------------------------
describe('§8 — what work a position can take', () => {
  const RESOURCE = { id: 'res-1', code: 'BAY-1', retiredAt: null, serviceCapabilities: [] as Array<{ capability: string }> };

  it('accepts values the catalogue actually uses, normalised and de-duplicated', async () => {
    const h = build();
    withVocabulary(h.prisma, ['ALIGNMENT', 'GENERAL', 'LUBE']);
    h.prisma.workResource.findUnique = vi.fn(async () => RESOURCE);
    const out = await h.service.setCapabilities('res-1', ['general', 'GENERAL', ' lube '], 'user-1');
    expect(out.capabilities).toEqual(['GENERAL', 'LUBE']);
  });

  it('refuses a capability nothing in the catalogue asks for, rather than silently storing it', async () => {
    const h = build();
    withVocabulary(h.prisma, ['ALIGNMENT', 'GENERAL']);
    h.prisma.workResource.findUnique = vi.fn(async () => RESOURCE);
    await expect(h.service.setCapabilities('res-1', ['ALIGMENT'], 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.workResourceCapability.createMany).not.toHaveBeenCalled();
  });

  it('replaces the set, so a bay can stop doing something', async () => {
    const h = build();
    withVocabulary(h.prisma, ['ALIGNMENT', 'GENERAL']);
    h.prisma.workResource.findUnique = vi.fn(async () => ({
      ...RESOURCE,
      serviceCapabilities: [{ capability: 'ALIGNMENT' }, { capability: 'GENERAL' }],
    }));
    await h.service.setCapabilities('res-1', ['GENERAL'], 'user-1');
    expect(h.prisma.workResourceCapability.deleteMany.mock.calls[0][0].where).toMatchObject({
      resourceId: 'res-1',
      capability: { notIn: ['GENERAL'] },
    });
  });

  it('does nothing and audits nothing when the set is unchanged', async () => {
    const h = build();
    withVocabulary(h.prisma, ['GENERAL']);
    h.prisma.workResource.findUnique = vi.fn(async () => ({ ...RESOURCE, serviceCapabilities: [{ capability: 'GENERAL' }] }));
    const out = await h.service.setCapabilities('res-1', ['GENERAL'], 'user-1');
    expect(out.changed).toBe(false);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('refuses to reconfigure a retired resource', async () => {
    const h = build();
    withVocabulary(h.prisma, ['GENERAL']);
    h.prisma.workResource.findUnique = vi.fn(async () => ({ ...RESOURCE, retiredAt: new Date() }));
    await expect(h.service.setCapabilities('res-1', ['GENERAL'], 'user-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound for an unknown resource instead of creating orphan capabilities', async () => {
    const h = build();
    await expect(h.service.setCapabilities('nope', ['GENERAL'], 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('§9 — capabilities never touch `capacity`: three skills is still one vehicle', () => {
    const src = readFileSync(join(__dirname, '..', 'resource-admin.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('async setCapabilities'));
    const method = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
    expect(method).not.toMatch(/capacity\s*[:=]/);
    expect(method).not.toContain('capacityRole');
  });
});

// ---------------------------------------------------------------------------
// §11 / §12 — capacity is derived, and honest about being incomplete
// ---------------------------------------------------------------------------
describe('§11 — the position count is worked out, never entered', () => {
  const src = readFileSync(join(__dirname, '..', 'resource-truth-audit.service.ts'), 'utf8');
  const derived = (() => {
    const body = src.slice(src.indexOf('private async derivedCapacity'));
    return body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
  })();

  it('reads from the resources themselves, not from a business-rule key', () => {
    expect(derived).toContain('countsTowardCapacity');
    // Reading a configured number here would defeat the whole stage.
    expect(derived).not.toContain('businessRuleConfig');
    expect(derived).not.toContain('booking_max_concurrent_appointments');
  });

  it('§12 — it refuses to present a complete picture while anything is unclassified', () => {
    expect(derived).toContain('configurationIncomplete');
    expect(derived).toContain('Capacity configuration incomplete');
    expect(derived).toContain("'LOWER_BOUND'");
  });

  it("§9 — pools are listed per capability and never summed into one number", () => {
    expect(derived).toContain('capabilityPools');
    // Each pool counts the positions that HAVE the capability; a resource with
    // several appears in several pools, which is versatility, not quantity.
    expect(derived).toContain('r.capabilities.includes(d.bay_type)');
  });
});

// ---------------------------------------------------------------------------
// §14 / §15 — the impact warning finally looks at the right thing
// ---------------------------------------------------------------------------
describe('§14 — taking the only alignment bay offline is not "no impact"', () => {
  const src = readFileSync(join(__dirname, '..', 'resource-admin.service.ts'), 'utf8');
  const method = (() => {
    const body = src.slice(src.indexOf('private async capabilityImpact'));
    return body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
  })();

  it('impact now asks about the capability, not only rows keyed on this resource id', () => {
    expect(src.slice(src.indexOf('async impact('))).toContain('capabilityImpact');
    expect(method).toContain('positionsAfter');
    expect(method).toContain('LAST_POSITION');
  });

  it('counts booked appointments through the service catalogue, not through assignments', () => {
    // Assignments never reference a resource in this platform, which is exactly
    // why the old count was always zero.
    expect(method).toContain('required_bay_type');
    expect(method).toContain('appointment_services');
  });

  it('§15 — it states what it cannot know instead of predicting a delay', () => {
    expect(method).toContain('does not model');
    expect(method).toContain('PHYSICAL CAPACITY REQUIRES CONFIRMATION');
  });

  it('a resource with no capabilities yields no capability warnings rather than a fabricated one', async () => {
    const h = build();
    h.prisma.workResource.findUnique = vi.fn(async () => ({
      id: 'res-1', occupancy: null, serviceCapabilities: [],
    }));
    const out = await h.service.impact('res-1');
    expect(out.capabilityImpact).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §6 — reconciliation shows both sides and merges neither
// ---------------------------------------------------------------------------
describe('§6 — the reconciliation view', () => {
  it('reports link state for resources and for bays, and never writes', async () => {
    const h = build();
    withVocabulary(h.prisma, ['GENERAL']);
    h.prisma.workResource.findMany = vi.fn(async () => [
      {
        id: 'res-1', code: 'BAY-1', name: 'Bay 1', resourceCategory: 'BAY', capacity: 1,
        capacityRole: 'UNVERIFIED', isActive: true, retiredAt: null, schedulingEnabled: true,
        legacyBayId: null, legacyBay: null, operationalStatus: null, serviceCapabilities: [],
      },
    ]);
    h.prisma.workBay.findMany = vi.fn(async () => [
      { id: 'bay-1', code: 'BAY-01', bayType: 'GENERAL', status: 'ACTIVE', reconciliationDisposition: 'UNRESOLVED', dispositionNote: null, dispositionedAt: null, resource: null, _count: { assignments: 40 } },
    ]);
    const out = await h.service.reconciliation(SITE);

    expect(out.resources[0].link.state).toBe('UNLINKED');
    expect(out.resources[0].needsAttention).toBe(true);
    // A bay with real history and no resource is the urgent case, not noise.
    expect(out.legacyBays[0].needsAttention).toBe(true);
    expect(out.legacyBays[0].historicalAssignments).toBe(40);
    expect(out.summary).toMatchObject({ linkedPairs: 0, unresolvedBaysWithHistory: 1, unverifiedResources: 1 });
    expect(h.prisma.workResource.update).not.toHaveBeenCalled();
  });

  it('shows AVAILABLE for a resource with no status row', async () => {
    const h = build();
    withVocabulary(h.prisma, ['GENERAL']);
    h.prisma.workResource.findMany = vi.fn(async () => [
      {
        id: 'res-1', code: 'BAY-1', name: 'Bay 1', resourceCategory: 'BAY', capacity: 1,
        capacityRole: 'PRIMARY_SERVICE_POSITION', isActive: true, retiredAt: null, schedulingEnabled: true,
        legacyBayId: null, legacyBay: null, operationalStatus: null, serviceCapabilities: [],
      },
    ]);
    const out = await h.service.reconciliation(SITE);
    expect(out.resources[0].operationalStatus).toBe('AVAILABLE');
    expect(out.resources[0].needsAttention).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The standing constraint: none of this may reach a customer yet
// ---------------------------------------------------------------------------
describe('Stage 5B changes nothing a customer can see', () => {
  const root = join(__dirname, '..', '..', '..', '..');

  it('the public booking engine does not read capacity roles or capabilities', () => {
    for (const file of ['public-booking/availability.engine.ts', 'public-booking/public-booking.service.ts']) {
      const src = readFileSync(join(root, 'src', 'modules', file), 'utf8');
      expect(src).not.toContain('capacityRole');
      expect(src).not.toContain('workResourceCapability');
      expect(src).not.toContain('serviceCapabilities');
    }
  });

  it('the booking availability service is still keyed on the fixed capacity rule', () => {
    const src = readFileSync(join(root, 'src', 'modules', 'scheduling', 'availability', 'booking-availability.service.ts'), 'utf8');
    expect(src).not.toContain('capacityRole');
  });
});
