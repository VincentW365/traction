import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogueReadinessService } from '../catalogue-readiness.service';

/**
 * CR-2026-108 Stage 4B — the readiness audit is DECISION SUPPORT.
 *
 * The single most important property is that it changes nothing. An audit that
 * quietly enabled whatever looked complete would defeat its own purpose: the
 * point is that a person decides which services a customer may book, with the
 * evidence in front of them.
 */

const SERVICE: {
  id: string; code: string; name: string; customerFacingName: string | null; family: string;
  baseDurationMinutes: number; bookingBufferMinutes: number; bookableOnline: boolean;
  appointmentOnly: boolean; quickService: boolean; isExternal: boolean; isActive: boolean;
  requiredSkillCode: string | null; requiredBayType: string | null; canUseOverflow: boolean;
  canUseLightSlot: boolean; requiresMileage: boolean; kpiComponents: Array<{ componentRole: string }>;
} = {
  id: 'st-1', code: 'OIL-01', name: 'Oil Change', customerFacingName: null, family: 'Quick Service',
  baseDurationMinutes: 30, bookingBufferMinutes: 0, bookableOnline: false,
  appointmentOnly: false, quickService: true, isExternal: false, isActive: true,
  requiredSkillCode: 'LUBE', requiredBayType: 'LUBE', canUseOverflow: false,
  canUseLightSlot: true, requiresMileage: true, kpiComponents: [],
};

type Svc = typeof SERVICE;

function build(services: Partial<Svc>[] = [{}], rules: Array<{ ruleKey: string; valueJson: unknown }> = []) {
  const full = services.map((s, i) => ({ ...SERVICE, id: `st-${i}`, ...s }));
  const writes: string[] = [];
  const trap = (name: string) => vi.fn(async () => { writes.push(name); return {}; });
  const prisma = {
    site: { findFirst: vi.fn(async () => ({ id: 'site-1' })) },
    businessRuleConfig: {
      findMany: vi.fn(async () => rules),
      findFirst: vi.fn(async () => ({ valueJson: 80 })),
    },
    serviceType: {
      findMany: vi.fn(async () => full),
      // Any write from an audit is a defect — these record the attempt.
      update: trap('serviceType.update'),
      updateMany: trap('serviceType.updateMany'),
      create: trap('serviceType.create'),
      delete: trap('serviceType.delete'),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) =>
      sql.includes('imported_linked') ? [{ live: 68, imported: 9055, imported_linked: 0 }] : [],
    ),
    $executeRawUnsafe: trap('$executeRawUnsafe'),
  };
  return { service: new CatalogueReadinessService(prisma as never), prisma, writes };
}

describe('CR-2026-108 §4B — the audit is read-only', () => {
  it('performs no write of any kind', async () => {
    const h = build([{}, { code: 'BRK-01', name: 'Brake Inspection', requiredBayType: 'GENERAL' }]);
    await h.service.audit();
    expect(h.writes).toEqual([]);
    expect(h.prisma.serviceType.update).not.toHaveBeenCalled();
    expect(h.prisma.serviceType.updateMany).not.toHaveBeenCalled();
  });

  it('never sets bookableOnline, however ready a service looks', async () => {
    const h = build([{}]);
    const r = await h.service.audit();
    expect(r.services[0].readiness).toBe('READY_FOR_REVIEW');
    expect(r.services[0].bookableOnline).toBe(false); // reported, not changed
    expect(h.writes).toEqual([]);
  });

  it('proposes a customer-facing name without writing it', async () => {
    const h = build([{ name: 'Belt / Hose Replacement' }]);
    const r = await h.service.audit();
    expect(r.services[0].customerFacingName).toBeNull();
    expect(r.services[0].proposedCustomerFacingName).toContain('or');
    expect(h.writes).toEqual([]);
  });

  /** A static guard: the file must contain no Prisma mutation at all. */
  it('contains no mutating Prisma call in its source', () => {
    const src = readFileSync(join(__dirname, '..', 'catalogue-readiness.service.ts'), 'utf8');
    for (const mutator of ['.update(', '.updateMany(', '.create(', '.createMany(', '.delete(', '.deleteMany(', '.upsert(', '$executeRaw']) {
      expect(src, `readiness audit must not call ${mutator}`).not.toContain(mutator);
    }
  });
});

describe('CR-2026-108 §4B — readiness is categorical and explained', () => {
  it('excludes external work structurally', async () => {
    const h = build([{ isExternal: true, name: 'Machine Shop Work' }]);
    const r = await h.service.audit();
    expect(r.services[0].readiness).toBe('NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE');
    expect(r.services[0].reasons[0]).toMatch(/not performed by the Service Centre/);
  });

  it('excludes diagnostic work — the duration is unknowable before inspection', async () => {
    const h = build([{ code: 'ENG-01', name: 'Engine Diagnostic', requiredBayType: 'DIAGNOSTIC' }]);
    const r = await h.service.audit();
    expect(r.services[0].readiness).toBe('NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE');
    expect(r.services[0].reasons[0]).toMatch(/unknown until the vehicle is examined/);
  });

  it('excludes a package sub-operation using the EXISTING relationship data', async () => {
    const h = build([{ code: 'OIL-FLT-01', name: 'Oil Filter Change', kpiComponents: [{ componentRole: 'INCLUDED_NO_ADDITIONAL_BENCHMARK' }] }]);
    const r = await h.service.audit();
    expect(r.services[0].catalogueRole).toBe('PACKAGE_COMPONENT');
    expect(r.services[0].readiness).toBe('NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE');
  });

  it('flags a missing duration as a blocker rather than guessing one', async () => {
    const h = build([{ baseDurationMinutes: 0 }]);
    const r = await h.service.audit();
    expect(r.services[0].flags.map((f) => f.code)).toContain('DURATION_MISSING');
    expect(r.services[0].readiness).toBe('NEEDS_CONFIGURATION');
  });

  it('flags two services a customer could not tell apart', async () => {
    const h = build([
      { code: 'BEL-01', name: 'Belt / Hose Replacement' },
      { code: 'BELT-01', name: 'Belt Replacement' },
    ]);
    const r = await h.service.audit();
    expect(r.services.map((s) => s.readiness)).toEqual(['NEEDS_CONFIGURATION', 'NEEDS_CONFIGURATION']);
    expect(r.services[0].flags.map((f) => f.code)).toContain('NAME_AMBIGUOUS');
  });

  /** The false positive this scoping rule exists to prevent. */
  it('does NOT call a service ambiguous against one that will never be offered', async () => {
    const h = build([
      { code: 'OIL-01', name: 'Oil Change' },
      { code: 'OIL-FLT-01', name: 'Oil Filter Change', kpiComponents: [{ componentRole: 'INCLUDED_NO_ADDITIONAL_BENCHMARK' }] },
    ]);
    const r = await h.service.audit();
    const oil = r.services.find((s) => s.code === 'OIL-01')!;
    expect(oil.flags.map((f) => f.code)).not.toContain('NAME_AMBIGUOUS');
    expect(oil.readiness).toBe('READY_FOR_REVIEW');
  });

  it('gives no numeric score anywhere', async () => {
    const h = build([{}]);
    const r = await h.service.audit();
    const json = JSON.stringify(r.services[0]);
    expect(json).not.toMatch(/"score"/);
    expect(r.services[0].reasons.length).toBeGreaterThan(0);
  });
});

describe('CR-2026-108 §4B — evidence is graded, never merged', () => {
  it('reports live-platform and historical-import separately', async () => {
    const h = build([{}]);
    const r = await h.service.audit();
    const sources = r.services[0].evidence.map((e) => e.source).sort();
    expect(sources).toEqual(['HISTORICAL_IMPORT', 'LIVE_PLATFORM']);
  });

  it('marks a tiny sample as insufficient rather than printing a median', async () => {
    const h = build([{}]);
    const r = await h.service.audit();
    for (const e of r.services[0].evidence) {
      expect(e.insufficient).toBe(true);
      expect(e.sampleCount).toBe(0);
    }
  });

  it('says plainly when imported records carry no service lines at all', async () => {
    const h = build([{}]);
    const r = await h.service.audit();
    expect(r.evidenceSummary.historicalImportLinkedToServices).toBe(0);
    expect(r.evidenceSummary.note).toMatch(/NO per-service historical duration evidence/);
  });
});

describe('CR-2026-108 §4B — proposals are proposals', () => {
  it('proposes a starting set drawn only from READY_FOR_REVIEW', async () => {
    const h = build([
      { code: 'OIL-01', name: 'Oil Change' },
      { code: 'ENG-01', name: 'Engine Diagnostic', requiredBayType: 'DIAGNOSTIC' },
    ]);
    const r = await h.service.audit();
    expect(r.proposedStartingSet.map((p) => p.code)).toEqual(['OIL-01']);
    expect(r.deliberatelyExcluded.map((e) => e.code)).toEqual(['ENG-01']);
  });

  it('proposes a zero buffer, because no evidence exists to derive one from', async () => {
    const h = build([{}]);
    const r = await h.service.audit();
    expect(r.proposedStartingSet[0].proposedBufferMinutes).toBe(0);
  });
});

/**
 * CR-2026-108 Stage 4D — the preview exists so nobody has to switch the feature
 * on to find out what /book will look like, and so the preflight can refuse the
 * one failure that matters: enforcement on with nothing to offer.
 */
describe('CR-2026-108 §4D — public catalogue preview', () => {
  it('previews exactly the services marked bookable, not everything active', async () => {
    const h = build([
      { code: 'OIL-01', name: 'Oil Change', bookableOnline: true, customerFacingName: 'Oil Change' },
      { code: 'BRK-02', name: 'Brake Pad Replacement', bookableOnline: false },
    ]);
    const r = await h.service.audit();
    expect(r.publicCataloguePreview.items.map((i) => i.code)).toEqual(['OIL-01']);
    expect(r.publicCataloguePreview.afterEnforcementServiceCount).toBe(1);
  });

  it('shows what the scheduler plans TODAY versus under CATALOGUE, so the difference is unmissable', async () => {
    const h = build([{ bookableOnline: true, baseDurationMinutes: 30, bookingBufferMinutes: 0 }]);
    const r = await h.service.audit();
    const item = r.publicCataloguePreview.items[0];
    // Configuring a catalogue duration has NOT changed production scheduling.
    expect(item.plannedMinutesToday).toBe(80);
    expect(item.plannedMinutesIfCatalogue).toBe(30);
    expect(r.publicCataloguePreview.durationSource).toBe('DEFAULT');
  });

  it('adds the buffer to the CATALOGUE figure but never to what the customer is quoted', async () => {
    const h = build([{ bookableOnline: true, baseDurationMinutes: 60, bookingBufferMinutes: 15 }]);
    const r = await h.service.audit();
    const item = r.publicCataloguePreview.items[0];
    expect(item.catalogueDurationMinutes).toBe(60); // what the customer is told
    expect(item.plannedMinutesIfCatalogue).toBe(75); // what the bay would hold
  });

  /** The "online booking suddenly offers nothing" failure. */
  it('preflight FAILS when nothing is marked bookable online', async () => {
    const h = build([{ bookableOnline: false }]);
    const r = await h.service.audit();
    expect(r.publicCataloguePreview.preflightFailures[0]).toMatch(/nothing to offer/);
  });

  it('preflight FAILS when an enabled service has no usable duration', async () => {
    const h = build([{ bookableOnline: true, baseDurationMinutes: 0 }]);
    const r = await h.service.audit();
    expect(r.publicCataloguePreview.preflightFailures.join(' ')).toMatch(/no usable catalogue duration/);
  });

  it('preflight passes for a properly configured service', async () => {
    const h = build([{ bookableOnline: true, customerFacingName: 'Oil Change' }]);
    const r = await h.service.audit();
    expect(r.publicCataloguePreview.preflightFailures).toEqual([]);
  });

  /** §9 — flagged for assessment, deliberately not solved by inventing a resource type. */
  it('flags a cleaning service that would consume a mechanical bay', async () => {
    const h = build([{ code: 'CLEAN-01', name: 'Vehicle Cleaning', bookableOnline: true, requiredBayType: 'GENERAL' }]);
    const r = await h.service.audit();
    expect(r.publicCataloguePreview.items[0].notes.join(' ')).toMatch(/same capacity as mechanical work/);
  });

  it('previewing changes nothing', async () => {
    const h = build([{ bookableOnline: true }]);
    await h.service.audit();
    expect(h.writes).toEqual([]);
  });
});
