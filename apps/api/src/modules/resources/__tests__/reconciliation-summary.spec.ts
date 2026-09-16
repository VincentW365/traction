import { describe, it, expect, vi } from 'vitest';
import { ReconciliationSummaryService } from '../reconciliation-summary.service';

/**
 * CR-2026-108 — the Stage 5C entry gate.
 *
 * The arithmetic error this report exists to prevent: reading the capability
 * column and adding it up. One bay that does alignment, lube and general work
 * appears in three pools; summing them turns six real positions into fourteen
 * imaginary ones, and the shop then promises work it cannot do. Several tests
 * below do nothing but pin that the two numbers are reported separately and
 * labelled.
 *
 * The second failure mode is subtler and cost me a revision: reporting "CANNOT
 * BE FULFILLED" for six bookable services when the real fact was "nobody has
 * classified a bay yet". A count of zero before the walk is a statement about
 * the data, not about the building.
 */

interface ResourceSeed {
  code: string;
  name?: string;
  capacityRole: string;
  capabilities?: string[];
  capacity?: number;
  category?: string;
  isActive?: boolean;
  schedulingEnabled?: boolean;
  retiredAt?: Date | null;
  status?: string | null;
  legacyBayId?: string | null;
  supportsSedan?: boolean;
  supportsSuv?: boolean;
  liftType?: string | null;
}

interface BaySeed {
  code: string;
  bayType?: string;
  status?: string;
  linkedTo?: string | null;
  assignments?: number;
  /** UNRESOLVED | HISTORICAL_ONLY | REPLACED | RETIRED */
  disposition?: string;
  note?: string;
}

function build(opts: {
  resources?: ResourceSeed[];
  bays?: BaySeed[];
  services?: Array<{ code: string; name: string; requiredBayType: string | null; bookableOnline?: boolean }>;
} = {}) {
  const resources = (opts.resources ?? []).map((r, i) => ({
    id: `res-${i}`,
    code: r.code,
    name: r.name ?? r.code,
    resourceCategory: r.category ?? 'BAY',
    capacity: r.capacity ?? 1,
    capacityRole: r.capacityRole,
    isActive: r.isActive ?? true,
    retiredAt: r.retiredAt ?? null,
    schedulingEnabled: r.schedulingEnabled ?? true,
    supportsSedan: r.supportsSedan ?? true,
    supportsSuv: r.supportsSuv ?? true,
    liftType: r.liftType ?? null,
    legacyBayId: r.legacyBayId ?? null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    operationalStatus: r.status ? { status: r.status } : null,
    serviceCapabilities: (r.capabilities ?? []).map((capability) => ({ capability })),
  }));
  const bays = (opts.bays ?? []).map((b, i) => ({
    id: `bay-${i}`,
    code: b.code,
    bayType: b.bayType ?? 'GENERAL',
    status: b.status ?? 'ACTIVE',
    reconciliationDisposition: b.disposition ?? 'UNRESOLVED',
    dispositionNote: b.note ?? null,
    dispositionedAt: b.disposition && b.disposition !== 'UNRESOLVED' ? new Date('2026-09-16T12:00:00Z') : null,
    resource: b.linkedTo ? { code: b.linkedTo } : null,
    _count: { assignments: b.assignments ?? 0 },
  }));
  const services = opts.services ?? [];
  const prisma = {
    workResource: { findMany: vi.fn(async () => resources) },
    workBay: { findMany: vi.fn(async () => bays) },
    serviceType: {
      findFirst: vi.fn(async () => services.find((s) => s.code === 'CLEAN-01') ?? null),
      findMany: vi.fn(async () => services.filter((s) => s.bookableOnline && s.requiredBayType).map((s) => ({ ...s, customerFacingName: null }))),
      // Other active services asking for the same capability as CLEAN-01.
      count: vi.fn(async ({ where }: { where: { requiredBayType: string; code: { not: string } } }) =>
        services.filter((s) => s.requiredBayType === where.requiredBayType && s.code !== where.code.not).length,
      ),
    },
  };
  return { service: new ReconciliationSummaryService(prisma as never), prisma };
}

const PRIMARY = 'PRIMARY_SERVICE_POSITION';

// ---------------------------------------------------------------------------
describe('the arithmetic guard — capability pools are not additive', () => {
  it('reports the sum and the truth as two different numbers', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL', 'LUBE', 'ALIGNMENT'] },
        { code: 'BAY-2', capacityRole: PRIMARY, capabilities: ['GENERAL'] },
      ],
    });
    const s = await h.service.summary();
    // Three pools + one = four pool-slots across two physical positions.
    expect(s.capabilityOverlap.sumOfPoolCounts).toBe(4);
    expect(s.capabilityOverlap.distinctPhysicalPositions).toBe(2);
    expect(s.capabilityOverlap.multiCapabilityPositions).toBe(1);
    expect(s.capabilityOverlap.note).toContain('NOT additive');
  });

  it('never publishes a single "total capability capacity" field to add up', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL', 'LUBE'] }],
    });
    const s = await h.service.summary();
    const keys = Object.keys(s.capabilityOverlap);
    expect(keys).not.toContain('totalCapacity');
    // The only figure resembling shop capacity counts physical positions once.
    expect(s.positions.activeNow).toBe(1);
  });

  it('marks a pool as shared rather than dedicated when the position does other work', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL', 'ALIGNMENT'] },
        { code: 'BAY-2', capacityRole: PRIMARY, capabilities: ['ALIGNMENT'] },
      ],
    });
    const s = await h.service.summary();
    const align = s.capabilities.find((c) => c.capability === 'ALIGNMENT')!;
    expect(align.verifiedPositions).toBe(2);
    expect(align.sharedPositions).toBe(1);
    expect(align.exclusivePositions).toBe(1);
  });

  it('still says pools are not additive when they happen not to overlap', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'] },
        { code: 'BAY-2', capacityRole: PRIMARY, capabilities: ['LUBE'] },
      ],
    });
    const s = await h.service.summary();
    expect(s.capabilityOverlap.sumOfPoolCounts).toBe(2);
    expect(s.capabilityOverlap.distinctPhysicalPositions).toBe(2);
    expect(s.capabilityOverlap.note).toContain('not additive by construction');
  });
});

// ---------------------------------------------------------------------------
describe('items 1-5, 11 — the census', () => {
  it('counts each role, and keeps status as a separate dimension', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY },
        { code: 'BAY-2', capacityRole: PRIMARY, status: 'MAINTENANCE' },
        { code: 'OVF-1', capacityRole: 'OVERFLOW_SERVICE_POSITION' },
        { code: 'JACK-1', capacityRole: 'SUPPORT_EQUIPMENT' },
        { code: 'BAY-9', capacityRole: 'PLACEHOLDER' },
        { code: 'BAY-8', capacityRole: 'UNVERIFIED' },
      ],
    });
    const s = await h.service.summary();
    expect(s.positions.verifiedPrimary).toBe(2);
    expect(s.positions.verifiedOverflow).toBe(1);
    expect(s.positions.supportEquipment).toBe(1);
    expect(s.positions.placeholders).toBe(1);
    expect(s.positions.unverified).toBe(1);
    // BAY-2 is still counted as a primary position AND as unavailable today.
    expect(s.positions.temporarilyUnavailable).toBe(1);
    expect(s.positions.activeNow).toBe(2); // BAY-1 + OVF-1; BAY-2 is in maintenance
  });

  it('never lets support equipment or a placeholder into the active figure', async () => {
    const h = build({
      resources: [
        { code: 'JACK-1', capacityRole: 'SUPPORT_EQUIPMENT', capabilities: ['GENERAL'] },
        { code: 'BAY-9', capacityRole: 'PLACEHOLDER', capabilities: ['GENERAL'] },
        { code: 'BAY-8', capacityRole: 'UNVERIFIED', capabilities: ['GENERAL'] },
      ],
    });
    const s = await h.service.summary();
    expect(s.positions.activeNow).toBe(0);
    expect(s.capabilities.find((c) => c.capability === 'GENERAL')!.verifiedPositions).toBe(0);
  });

  it('respects a multi-vehicle position rather than assuming every bay is one', async () => {
    const h = build({ resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capacity: 2, capabilities: ['GENERAL'] }] });
    const s = await h.service.summary();
    expect(s.positions.activeNow).toBe(2);
    expect(s.capabilities.find((c) => c.capability === 'GENERAL')!.verifiedPositions).toBe(2);
  });

  it('excludes EXTERNAL from the unclassified count — it is not this shop to classify', async () => {
    const h = build({
      resources: [
        { code: 'MSHOP', capacityRole: 'UNVERIFIED', category: 'EXTERNAL' },
        { code: 'BAY-1', capacityRole: 'UNVERIFIED' },
      ],
    });
    const s = await h.service.summary();
    expect(s.positions.unverified).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('items 6 & 7 — named capabilities and anything the shop added', () => {
  it('lists the five named types first, in the order management gave', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['TIRE', 'GENERAL', 'DETAIL'] }],
    });
    const s = await h.service.summary();
    expect(s.capabilities.slice(0, 5).map((c) => c.capability)).toEqual([
      'GENERAL', 'LUBE', 'ALIGNMENT', 'INSPECTION', 'TIRE',
    ]);
    expect(s.capabilities.every((c, i) => (i < 5 ? c.isNamedType : true))).toBe(true);
  });

  it('reports a named capability with zero positions rather than omitting it', async () => {
    const h = build({ resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'] }] });
    const s = await h.service.summary();
    // Silence would read as "not asked"; zero reads as "asked, and there are none".
    expect(s.capabilities.find((c) => c.capability === 'TIRE')).toMatchObject({ verifiedPositions: 0 });
  });

  it('flags an extra capability as additional rather than hiding it', async () => {
    const h = build({ resources: [{ code: 'PW-1', capacityRole: PRIMARY, capabilities: ['DETAIL'] }] });
    const s = await h.service.summary();
    expect(s.capabilities.find((c) => c.capability === 'DETAIL')).toMatchObject({ isNamedType: false, verifiedPositions: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('item 8 — vehicle restrictions', () => {
  it('names the mobile-jack rule as its own thing, not as a plain sedan-only bay', async () => {
    const h = build({ resources: [{ code: 'MJACK-1', capacityRole: PRIMARY, liftType: 'mobile' }] });
    const s = await h.service.summary();
    expect(s.vehicleRestrictions[0].restriction).toBe('MOBILE_JACK_SEDAN_RULE');
    expect(s.vehicleRestrictions[0].detail).toContain('override');
  });

  it('reports sedan-only and SUV-only separately', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, supportsSuv: false },
        { code: 'BAY-2', capacityRole: PRIMARY, supportsSedan: false },
      ],
    });
    const s = await h.service.summary();
    expect(s.vehicleRestrictions.map((v) => v.restriction)).toEqual(['SEDAN_ONLY', 'SUV_ONLY']);
  });

  it('flags a resource no vehicle can use at all', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, supportsSedan: false, supportsSuv: false }],
    });
    const s = await h.service.summary();
    expect(s.vehicleRestrictions[0].restriction).toBe('NO_VEHICLE_CLASS');
  });

  it('says nothing when everything takes both classes', async () => {
    const h = build({ resources: [{ code: 'BAY-1', capacityRole: PRIMARY }] });
    expect((await h.service.summary()).vehicleRestrictions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('items 9 & 10 — the two inventories', () => {
  it('lists unaccounted-for bays with their history, which is what makes them urgent', async () => {
    const h = build({
      bays: [
        { code: 'BAY-01', assignments: 39 },
        { code: 'BAY-06', bayType: 'INSPECTION', assignments: 0 },
        { code: 'BAY-02', linkedTo: 'BAY-2', assignments: 6 },
      ],
    });
    const s = await h.service.summary();
    expect(s.unresolvedLegacyBays.map((b) => b.code)).toEqual(['BAY-01', 'BAY-06']);
    expect(s.unresolvedLegacyBays[0].historicalAssignments).toBe(39);
  });

  it('refuses to call unlinked resources "expansion" while reconciliation is unfinished', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY }],
      bays: [{ code: 'BAY-01', assignments: 39 }],
    });
    const s = await h.service.summary();
    expect(s.expansion.reconciliationComplete).toBe(false);
    expect(s.expansion.note).toContain('mixes genuine expansion');
  });

  it('calls them expansion once every bay is linked or accounted for', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, legacyBayId: 'bay-0' },
        { code: 'BAY-8', capacityRole: PRIMARY },
      ],
      bays: [{ code: 'BAY-01', linkedTo: 'BAY-1', assignments: 39 }],
    });
    const s = await h.service.summary();
    expect(s.expansion.reconciliationComplete).toBe(true);
    expect(s.expansion.resources.map((r) => r.code)).toEqual(['BAY-8']);
    expect(s.expansion.note).toContain('genuinely new capacity');
  });
});

// ---------------------------------------------------------------------------
/**
 * A bay demolished during the expansion has no current resource and never will.
 * The gate used to demand a link anyway, which pushed towards inventing one — and
 * an invented link is a fact the resource-aware engine would then reason from.
 */
describe('a legacy bay is resolved by a link OR by being accounted for', () => {
  const DISPOSITIONS = ['HISTORICAL_ONLY', 'REPLACED', 'RETIRED'];

  it.each(DISPOSITIONS)('%s resolves a bay without any link', async (disposition) => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'] }],
      bays: [{ code: 'BAY-01', assignments: 39, disposition, note: 'Demolished during the 2026 expansion.' }],
    });
    const s = await h.service.summary();
    expect(s.unresolvedLegacyBays).toEqual([]);
    expect(s.readyForStage5C).toBe(true);
  });

  it('keeps every historical assignment on a dispositioned bay', async () => {
    const h = build({
      bays: [{ code: 'BAY-01', assignments: 39, disposition: 'HISTORICAL_ONLY', note: 'Absorbed into BAY-08.' }],
    });
    const s = await h.service.summary();
    // The count is reported, not reduced. Dispositioning records a fact about the
    // building; it must never look like a reason to tidy history away.
    expect(s.dispositionedLegacyBays[0]).toMatchObject({
      code: 'BAY-01', disposition: 'HISTORICAL_ONLY', historicalAssignments: 39, note: 'Absorbed into BAY-08.',
    });
  });

  it('reports linked and dispositioned bays separately — they are different facts', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-0' }],
      bays: [
        { code: 'BAY-01', linkedTo: 'BAY-1', assignments: 39 },
        { code: 'BAY-02', assignments: 6, disposition: 'REPLACED', note: 'Floor reorganised; no 1:1 successor.' },
      ],
    });
    const s = await h.service.summary();
    expect(s.dispositionedLegacyBays.map((b) => b.code)).toEqual(['BAY-02']);
    expect(s.unresolvedLegacyBays).toEqual([]);
  });

  it('still blocks on a bay nobody has said anything about', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'] }],
      bays: [
        { code: 'BAY-01', assignments: 39, disposition: 'HISTORICAL_ONLY', note: 'Gone.' },
        { code: 'BAY-02', assignments: 6 },
      ],
    });
    const s = await h.service.summary();
    expect(s.unresolvedLegacyBays.map((b) => b.code)).toEqual(['BAY-02']);
    expect(s.readyForStage5C).toBe(false);
  });

  it('tells the reader not to invent a link to clear the blocker', async () => {
    const h = build({ bays: [{ code: 'BAY-01', assignments: 39 }] });
    const s = await h.service.summary();
    const blocker = s.blockers.find((b) => b.includes('not yet accounted for'))!;
    expect(blocker).toContain('do not invent a link');
  });
});

// ---------------------------------------------------------------------------
describe('item 12 — where Vehicle Cleaning happens', () => {
  const CLEAN = { code: 'CLEAN-01', name: 'Vehicle Cleaning', requiredBayType: 'GENERAL', bookableOnline: true };

  const REPAIR = { code: 'BRK-01', name: 'Brake Inspection', requiredBayType: 'GENERAL' };

  it('says cleaning competes for repair capacity when repairs need the same capability', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'] }],
      services: [CLEAN, REPAIR],
    });
    const s = await h.service.summary();
    expect(s.vehicleCleaning.verdict).toBe('SHARES_MECHANICAL_POSITION');
    expect(s.vehicleCleaning.detail).toContain('occupies repair capacity');
  });

  /**
   * The trap this pins: a bay carrying ONLY 'GENERAL' looks dedicated if you ask
   * "does this position do anything else". It is not — GENERAL is what repairs
   * ask for too, so that bay is a repair bay with a hose. The question has to be
   * asked of the catalogue, not of the bay.
   */
  it('does NOT call a position dedicated just because it carries one capability', async () => {
    const h = build({
      resources: [
        { code: 'PWASH-01', capacityRole: PRIMARY, capabilities: ['GENERAL'], category: 'POWER_WASH' },
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL', 'LUBE'] },
      ],
      services: [CLEAN, REPAIR],
    });
    const s = await h.service.summary();
    expect(s.vehicleCleaning.verdict).toBe('SHARES_MECHANICAL_POSITION');
    // And it says what would actually fix it.
    expect(s.vehicleCleaning.detail).toContain('capability of its own');
  });

  it('says dedicated only when the capability belongs to cleaning alone', async () => {
    const h = build({
      resources: [
        { code: 'PWASH-01', capacityRole: PRIMARY, capabilities: ['DETAIL'], category: 'POWER_WASH' },
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL', 'LUBE'] },
      ],
      services: [{ ...CLEAN, requiredBayType: 'DETAIL' }, REPAIR],
    });
    const s = await h.service.summary();
    expect(s.vehicleCleaning.verdict).toBe('DEDICATED_POSITION');
    expect(s.vehicleCleaning.positions).toEqual(['PWASH-01']);
  });

  it('does not guess when nothing carries the capability', async () => {
    const h = build({ resources: [{ code: 'BAY-1', capacityRole: PRIMARY }], services: [CLEAN] });
    expect((await h.service.summary()).vehicleCleaning.verdict).toBe('NO_VERIFIED_POSITION');
  });

  it('does not guess when the service has no required capability', async () => {
    const h = build({ services: [{ ...CLEAN, requiredBayType: null }] });
    expect((await h.service.summary()).vehicleCleaning.verdict).toBe('NOT_DETERMINED');
  });

  /**
   * This finding does NOT close when the walk finishes. Classifying bays cannot
   * answer it, because the answer lives in the catalogue. So it stays open, and
   * the fix stays a proposal until a person confirms the physical arrangement.
   */
  it('stays open for management even with a fully classified shop', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-0' }],
      bays: [{ code: 'BAY-01', linkedTo: 'BAY-1' }],
      services: [CLEAN, REPAIR],
    });
    const s = await h.service.summary();
    expect(s.readyForStage5C).toBe(true);
    // Ready to build on, and this question still unanswered. Both are true.
    expect(s.vehicleCleaning.managementConfirmation).toMatchObject({
      open: true,
      status: 'AWAITING_PHYSICAL_CONFIRMATION',
    });
  });

  it('proposes CLEANING additively, and only after confirmation', async () => {
    const h = build({
      resources: [{ code: 'PWASH-01', capacityRole: PRIMARY, capabilities: ['GENERAL'] }],
      services: [CLEAN, REPAIR],
    });
    const { proposalIfDedicated } = (await h.service.summary()).vehicleCleaning.managementConfirmation;
    expect(proposalIfDedicated).toContain('add CLEANING');
    expect(proposalIfDedicated).toContain('Additive');
    expect(proposalIfDedicated).toContain('NOT implemented');
    expect(proposalIfDedicated).toContain('after physical confirmation');
  });

  it('stays open when configuration cannot answer the question at all', async () => {
    const h = build({ services: [{ ...CLEAN, requiredBayType: null }] });
    expect((await h.service.summary()).vehicleCleaning.managementConfirmation.open).toBe(true);
  });

  it('closes only once cleaning genuinely has a capability of its own', async () => {
    const h = build({
      resources: [{ code: 'PWASH-01', capacityRole: PRIMARY, capabilities: ['CLEANING'] }],
      services: [{ ...CLEAN, requiredBayType: 'CLEANING' }, REPAIR],
    });
    const s = await h.service.summary();
    expect(s.vehicleCleaning.verdict).toBe('DEDICATED_POSITION');
    expect(s.vehicleCleaning.managementConfirmation).toMatchObject({ open: false, status: 'NOT_APPLICABLE' });
  });

  it('CLEANING is not in the capability vocabulary until CLEAN-01 is remapped', async () => {
    // The vocabulary is derived from what the catalogue asks for, so the proposal
    // cannot leak into the UI as an assignable option before it is approved.
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'] }],
      services: [CLEAN, REPAIR],
    });
    const s = await h.service.summary();
    expect(s.capabilities.map((c) => c.capability)).not.toContain('CLEANING');
  });
});

// ---------------------------------------------------------------------------
describe('item 13 — bookable services on a single position', () => {
  const COMPLETE = {
    resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['ALIGNMENT'], legacyBayId: 'bay-0' }],
    bays: [{ code: 'BAY-01', linkedTo: 'BAY-1', assignments: 1 }],
  };

  it('flags a service whose capability has exactly one verified position', async () => {
    const h = build({
      ...COMPLETE,
      services: [{ code: 'TIR-02', name: 'Wheel Alignment', requiredBayType: 'ALIGNMENT', bookableOnline: true }],
    });
    const s = await h.service.summary();
    expect(s.singlePositionBookableServices[0]).toMatchObject({
      code: 'TIR-02', verifiedPositions: 1, severity: 'SINGLE_POSITION', basis: 'VERIFIED',
    });
  });

  it('does not flag a service with two or more positions', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-0' },
        { code: 'BAY-2', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-1' },
      ],
      bays: [{ code: 'BAY-01', linkedTo: 'BAY-1' }, { code: 'BAY-02', linkedTo: 'BAY-2' }],
      services: [{ code: 'BRK-01', name: 'Brake Inspection', requiredBayType: 'GENERAL', bookableOnline: true }],
    });
    expect((await h.service.summary()).singlePositionBookableServices).toEqual([]);
  });

  it('ignores a service that is not offered online', async () => {
    const h = build({
      ...COMPLETE,
      services: [{ code: 'ENG-01', name: 'Engine work', requiredBayType: 'ALIGNMENT', bookableOnline: false }],
    });
    expect((await h.service.summary()).singlePositionBookableServices).toEqual([]);
  });

  /**
   * The distinction that matters most on this screen: before the walk, a pool of
   * zero means nobody has classified a bay. Reporting that as "no position able
   * to do the work" is an alarm about the data dressed up as one about the shop.
   */
  it('marks a zero count as a configuration gap while the walk is unfinished', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: 'UNVERIFIED' }],
      services: [{ code: 'TIR-02', name: 'Wheel Alignment', requiredBayType: 'ALIGNMENT', bookableOnline: true }],
    });
    const s = await h.service.summary();
    expect(s.singlePositionBookableServices[0].basis).toBe('INCOMPLETE_CONFIGURATION');
    // ...and it must not appear as its own blocker, which would double-count the
    // one real problem: nobody has walked the shop yet.
    expect(s.blockers.some((b) => b.includes('TIR-02'))).toBe(false);
  });

  it('raises it as a genuine blocker once the walk IS finished', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-0' }],
      bays: [{ code: 'BAY-01', linkedTo: 'BAY-1' }],
      services: [{ code: 'TIR-02', name: 'Wheel Alignment', requiredBayType: 'ALIGNMENT', bookableOnline: true }],
    });
    const s = await h.service.summary();
    expect(s.singlePositionBookableServices[0]).toMatchObject({ severity: 'NO_POSITION', basis: 'VERIFIED' });
    expect(s.blockers.some((b) => b.includes('TIR-02'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('readiness, and the promise that nothing is written', () => {
  it('is NOT ready while anything is unclassified', async () => {
    const h = build({ resources: [{ code: 'BAY-1', capacityRole: 'UNVERIFIED' }] });
    const s = await h.service.summary();
    expect(s.readyForStage5C).toBe(false);
    expect(s.blockers[0]).toContain('unclassified');
  });

  it('is NOT ready while a legacy bay is neither linked nor accounted for', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-9' }],
      bays: [{ code: 'BAY-01', assignments: 39 }],
    });
    const s = await h.service.summary();
    expect(s.readyForStage5C).toBe(false);
    expect(s.blockers.some((b) => b.includes('not yet accounted for'))).toBe(true);
  });

  it('is NOT ready when positions exist but carry no capability', async () => {
    const h = build({
      resources: [{ code: 'BAY-1', capacityRole: PRIMARY, legacyBayId: 'bay-0' }],
      bays: [{ code: 'BAY-01', linkedTo: 'BAY-1' }],
    });
    const s = await h.service.summary();
    expect(s.readyForStage5C).toBe(false);
    expect(s.blockers.some((b) => b.includes('none carries a capability'))).toBe(true);
  });

  it('is ready once the walk is genuinely complete', async () => {
    const h = build({
      resources: [
        { code: 'BAY-1', capacityRole: PRIMARY, capabilities: ['GENERAL'], legacyBayId: 'bay-0' },
        { code: 'JACK-1', capacityRole: 'SUPPORT_EQUIPMENT' },
      ],
      bays: [{ code: 'BAY-01', linkedTo: 'BAY-1', assignments: 39 }],
      services: [{ code: 'BRK-01', name: 'Brake Inspection', requiredBayType: 'LUBE', bookableOnline: false }],
    });
    const s = await h.service.summary();
    expect(s.blockers).toEqual([]);
    expect(s.readyForStage5C).toBe(true);
  });

  it('touches nothing — the gate report is a read', async () => {
    const h = build({ resources: [{ code: 'BAY-1', capacityRole: 'UNVERIFIED' }] });
    await h.service.summary();
    const calls = JSON.stringify(Object.keys(h.prisma.workResource));
    expect(calls).toBe('["findMany"]');
    expect(Object.keys(h.prisma.workBay)).toEqual(['findMany']);
  });
});
