import { describe, it, expect, vi } from 'vitest';
import { ResourceReadinessService, SHADOW_VALIDATION_KEY } from '../resource-readiness.service';

/**
 * CR-2026-108 §3/§4/§6/§7/§8 — what should and should not hold the gate shut.
 *
 * The first version blocked production on "any unclassified resource", and that
 * was wrong in a way that never resolves itself: an UNVERIFIED resource
 * contributes ZERO, so ignoring it makes the model CONSERVATIVE. It cannot cause
 * overbooking — the worst it can do is under-offer capacity the shop has. A jack
 * nobody had labelled could veto a scheduling model that was already safe.
 *
 * The gate is now the only question that matters: can every service a customer
 * can book actually be fulfilled by a verified position?
 */

interface Res {
  code: string;
  capacityRole?: string;
  capabilities?: string[];
  category?: string;
  capacity?: number;
  isActive?: boolean;
  retiredAt?: Date | null;
  schedulingEnabled?: boolean;
  status?: string | null;
  supportsSedan?: boolean;
  supportsSuv?: boolean;
  identityConfirmedAt?: Date | null;
}

interface Svc {
  code: string;
  name?: string;
  requiredBayType: string | null;
}

const VALID = {
  fingerprint: 'fp',
  at: '2026-09-18T08:00:00.000Z',
  services: ['OIL-01'],
  slotsCompared: 100,
  oversold: 0,
  undersold: 0,
  incomplete: 0,
};

function build(opts: { resources?: Res[]; services?: Svc[]; validation?: unknown | null } = {}) {
  const resources = (opts.resources ?? []).map((r) => ({
    code: r.code,
    name: r.code,
    capacityRole: r.capacityRole ?? 'PRIMARY_SERVICE_POSITION',
    capacity: r.capacity ?? 1,
    isActive: r.isActive ?? true,
    retiredAt: r.retiredAt ?? null,
    schedulingEnabled: r.schedulingEnabled ?? true,
    resourceCategory: r.category ?? 'BAY',
    supportsSedan: r.supportsSedan ?? true,
    supportsSuv: r.supportsSuv ?? true,
    identityConfirmedAt: r.identityConfirmedAt ?? null,
    operationalStatus: r.status ? { status: r.status, reason: null } : null,
    serviceCapabilities: (r.capabilities ?? ['GENERAL']).map((capability) => ({ capability })),
  }));
  const services = (opts.services ?? []).map((s) => ({
    code: s.code,
    name: s.name ?? s.code,
    customerFacingName: null,
    requiredBayType: s.requiredBayType,
  }));
  const validation = opts.validation === undefined ? VALID : opts.validation;
  const prisma = {
    workResource: { findMany: vi.fn(async () => resources) },
    serviceType: { findMany: vi.fn(async () => services) },
    businessRuleConfig: {
      findMany: vi.fn(async () => [
        { ruleKey: 'booking_capacity_mode', valueJson: 'FIXED' },
        { ruleKey: 'booking_max_concurrent_appointments', valueJson: 2 },
        { ruleKey: 'appointment_duration_source', valueJson: 'DEFAULT' },
      ]),
      findFirst: vi.fn(async ({ where }: { where: { ruleKey: string } }) =>
        where.ruleKey === SHADOW_VALIDATION_KEY && validation ? { valueJson: validation } : null,
      ),
    },
  };
  return { service: new ResourceReadinessService(prisma as never), prisma };
}

/** Eight confirmed general bays, which is the live baseline. */
const EIGHT: Res[] = Array.from({ length: 8 }, (_, i) => ({ code: `BAY-0${i + 1}`, capabilities: ['GENERAL'] }));
const READY_SHOP = {
  resources: EIGHT,
  services: [{ code: 'BRK-01', requiredBayType: 'GENERAL' }],
  validation: { ...VALID, fingerprint: 'fp' },
};

// ---------------------------------------------------------------------------
describe('§3 — an unverified resource is a WARNING, never a blocker', () => {
  it('does not block production, because contributing zero cannot overbook anyone', async () => {
    const h = build({
      ...READY_SHOP,
      resources: [...EIGHT, { code: 'MJACK-01', capacityRole: 'UNVERIFIED' }, { code: 'OVF-01', capacityRole: 'UNVERIFIED' }],
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.production.ready).toBe(true);
    const finding = r.production.findings.find((f) => f.id === 'optional-unverified')!;
    expect(finding.severity).toBe('WARNING');
    expect(r.production.blockers.map((b) => b.id)).not.toContain('optional-unverified');
  });

  it('stays loud — the warning names them and says what is lost', async () => {
    const h = build({ ...READY_SHOP, resources: [...EIGHT, { code: 'OVF-01', capacityRole: 'UNVERIFIED' }] });
    const r = await h.service.assess(undefined, 'fp');
    const w = r.production.warnings.find((f) => f.id === 'optional-unverified')!;
    expect(w.detail).toContain('OVF-01');
    expect(w.detail).toContain('conservative');
    expect(r.current.optionalUnverifiedResources).toBe(1);
  });

  it('but an unfulfillable public service IS a blocker', async () => {
    const h = build({
      resources: EIGHT,
      services: [{ code: 'OIL-01', requiredBayType: 'LUBE' }],
      validation: { ...VALID, fingerprint: 'fp' },
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.production.ready).toBe(false);
    expect(r.production.blockers.map((b) => b.id)).toContain('public-services-fulfillable');
  });
});

// ---------------------------------------------------------------------------
describe('§4 — EXTERNAL is out of scope, not merely unblocking', () => {
  it('is excluded from the unresolved INTERNAL total entirely', async () => {
    const h = build({
      ...READY_SHOP,
      resources: [...EIGHT, { code: 'MSHOP-EXT', capacityRole: 'UNVERIFIED', category: 'EXTERNAL' }],
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.current.optionalUnverifiedResources).toBe(0);
    expect(r.current.externalResources).toBe(1);
    // Not even a warning: it is somebody else's resource.
    expect(r.production.findings.find((f) => f.id === 'optional-unverified')!.severity).toBe('OK');
  });

  it('contributes no capability positions', async () => {
    const h = build({
      ...READY_SHOP,
      resources: [
        ...EIGHT,
        { code: 'MSHOP-EXT', capacityRole: 'PRIMARY_SERVICE_POSITION', category: 'EXTERNAL', capabilities: ['GENERAL'] },
      ],
    });
    const r = await h.service.assess(undefined, 'fp');
    // Eight, not nine — an external machine shop is not one of our bays.
    expect(r.current.capabilityPositions.GENERAL).toBe(8);
  });
});

// ---------------------------------------------------------------------------
describe('§8 — the gate is public-service fulfillability', () => {
  const SIX: Svc[] = [
    { code: 'OIL-01', requiredBayType: 'LUBE' },
    { code: 'TIR-01', requiredBayType: 'GENERAL' },
    { code: 'BRK-01', requiredBayType: 'GENERAL' },
    { code: 'TIR-02', requiredBayType: 'ALIGNMENT' },
    { code: 'INSP-01', requiredBayType: 'INSPECTION' },
    { code: 'CLEAN-01', requiredBayType: 'GENERAL' },
  ];

  it('reports each service with its capability and verified positions', async () => {
    const h = build({ resources: EIGHT, services: SIX, validation: { ...VALID, fingerprint: 'fp' } });
    const r = await h.service.assess(undefined, 'fp');
    const byCode = Object.fromEntries(r.publicServices.map((s) => [s.code, s]));
    expect(byCode['TIR-01']).toMatchObject({ requiredCapability: 'GENERAL', verifiedEligiblePositions: 8, status: 'READY' });
    expect(byCode['OIL-01']).toMatchObject({ requiredCapability: 'LUBE', verifiedEligiblePositions: 0, status: 'INCOMPLETE' });
    expect(byCode['TIR-02'].status).toBe('INCOMPLETE');
    expect(byCode['INSP-01'].status).toBe('INCOMPLETE');
  });

  it('blocks while any service is INCOMPLETE, and names which', async () => {
    const h = build({ resources: EIGHT, services: SIX, validation: { ...VALID, fingerprint: 'fp' } });
    const r = await h.service.assess(undefined, 'fp');
    const blocker = r.production.blockers.find((b) => b.id === 'public-services-fulfillable')!;
    for (const code of ['OIL-01', 'TIR-02', 'INSP-01']) expect(blocker.detail).toContain(code);
    expect(blocker.detail).not.toContain('TIR-01');
  });

  it('clears once each specialty has a position', async () => {
    const h = build({
      resources: [
        { code: 'BAY-01', capabilities: ['GENERAL', 'LUBE'] },
        { code: 'BAY-02', capabilities: ['GENERAL', 'ALIGNMENT'] },
        { code: 'BAY-03', capabilities: ['GENERAL', 'INSPECTION'] },
        ...EIGHT.slice(3),
      ],
      services: SIX,
      validation: { ...VALID, fingerprint: 'fp' },
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.publicServices.every((s) => s.status === 'READY')).toBe(true);
    expect(r.production.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('§6 — one position is a valid answer', () => {
  it('a single verified position makes a service READY, not incomplete', async () => {
    const h = build({
      resources: [{ code: 'BAY-01', capabilities: ['GENERAL', 'ALIGNMENT'] }, ...EIGHT.slice(1)],
      services: [{ code: 'TIR-02', requiredBayType: 'ALIGNMENT' }],
      validation: { ...VALID, fingerprint: 'fp' },
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.publicServices[0]).toMatchObject({ status: 'READY', verifiedEligiblePositions: 1, singlePointOfFailure: true });
    expect(r.production.ready).toBe(true);
  });

  it('the single point of failure is a WARNING, not evidence a second should exist', async () => {
    const h = build({
      resources: [{ code: 'BAY-01', capabilities: ['GENERAL', 'ALIGNMENT'] }, ...EIGHT.slice(1)],
      services: [{ code: 'TIR-02', requiredBayType: 'ALIGNMENT' }],
      validation: { ...VALID, fingerprint: 'fp' },
    });
    const r = await h.service.assess(undefined, 'fp');
    const w = r.production.warnings.find((f) => f.id === 'single-point-of-failure')!;
    expect(w.severity).toBe('WARNING');
    expect(w.detail).toContain('not evidence a second one exists');
  });
});

// ---------------------------------------------------------------------------
describe('§1 — provisional identity is reported, and does not block', () => {
  it('counts positions nobody has physically confirmed', async () => {
    const h = build({ ...READY_SHOP });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.current.provisionalIdentities).toBe(8);
    const w = r.production.warnings.find((f) => f.id === 'provisional-identities')!;
    expect(w.severity).toBe('WARNING');
    expect(w.detail).toContain('The COUNT is management-confirmed');
    // Provisional identity does not make the shop unsafe: the bays exist.
    expect(r.production.ready).toBe(true);
  });

  it('falls to zero as each is confirmed', async () => {
    const h = build({ ...READY_SHOP, resources: EIGHT.map((r) => ({ ...r, identityConfirmedAt: new Date() })) });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.current.provisionalIdentities).toBe(0);
    expect(r.production.findings.find((f) => f.id === 'provisional-identities')!.severity).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
describe('genuine safety blockers', () => {
  it('a counted position that accepts no vehicle class', async () => {
    const h = build({
      ...READY_SHOP,
      resources: [...EIGHT, { code: 'BAY-99', supportsSedan: false, supportsSuv: false }],
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.production.blockers.map((b) => b.id)).toContain('no-contradictory-configuration');
  });

  it('a counted position that declares no capability', async () => {
    const h = build({ ...READY_SHOP, resources: [...EIGHT, { code: 'BAY-99', capabilities: [] }] });
    const r = await h.service.assess(undefined, 'fp');
    const b = r.production.blockers.find((f) => f.id === 'no-contradictory-configuration')!;
    expect(b.detail).toContain('declares no capability');
  });

  it('shadow validation never run', async () => {
    const h = build({ ...READY_SHOP, validation: null });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.production.blockers.map((b) => b.id)).toContain('shadow-validated');
  });

  it('shadow validation against a different configuration', async () => {
    const h = build({ ...READY_SHOP, validation: { ...VALID, fingerprint: 'OLD' } });
    const r = await h.service.assess(undefined, 'fp');
    const b = r.production.blockers.find((f) => f.id === 'shadow-validated')!;
    expect(b.detail).toContain('Re-run');
  });

  it('a validation that found the shop being oversold', async () => {
    const h = build({ ...READY_SHOP, validation: { ...VALID, oversold: 12 } });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.production.blockers.map((b) => b.id)).toContain('no-unfulfillable-offer');
  });

  it('a validation that could not evaluate every service', async () => {
    const h = build({ ...READY_SHOP, validation: { ...VALID, incomplete: 236 } });
    const r = await h.service.assess(undefined, 'fp');
    const b = r.production.blockers.find((f) => f.id === 'shadow-evaluable')!;
    expect(b.detail).toContain('cannot be trusted with a decision it cannot make');
  });

  it('undersold alone does NOT block — refusing work is not unsafe', async () => {
    const h = build({ ...READY_SHOP, validation: { ...VALID, undersold: 400 } });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.production.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('§7 — shadow readiness is a much lower bar', () => {
  it('is ready with eight bays and eight unclassified resources', async () => {
    const h = build({
      ...READY_SHOP,
      resources: [...EIGHT, ...Array.from({ length: 8 }, (_, i) => ({ code: `X-${i}`, capacityRole: 'UNVERIFIED' }))],
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.shadow.ready).toBe(true);
    expect(r.shadow.summary).toContain('LOWER BOUND');
  });

  it('is ready even while production is blocked', async () => {
    const h = build({
      resources: EIGHT,
      services: [{ code: 'OIL-01', requiredBayType: 'LUBE' }],
      validation: null,
    });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.shadow.ready).toBe(true);
    expect(r.production.ready).toBe(false);
  });

  it('is not ready when nothing is classified at all', async () => {
    const h = build({ resources: EIGHT.map((r) => ({ ...r, capacityRole: 'UNVERIFIED' })), services: [] });
    const r = await h.service.assess(undefined, 'fp');
    expect(r.shadow.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the activation guard only sees blockers', () => {
  it('returns nothing when the only findings are warnings', async () => {
    const h = build({ ...READY_SHOP, resources: [...EIGHT, { code: 'OVF-01', capacityRole: 'UNVERIFIED' }] });
    expect(await h.service.productionActivationBlockers(undefined, 'fp')).toEqual([]);
  });

  it('returns the blockers, named, when there are any', async () => {
    const h = build({
      resources: EIGHT,
      services: [{ code: 'OIL-01', requiredBayType: 'LUBE' }],
      validation: { ...VALID, fingerprint: 'fp' },
    });
    const blockers = await h.service.productionActivationBlockers(undefined, 'fp');
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join(' ')).toContain('OIL-01');
  });
});

// ---------------------------------------------------------------------------
describe('the capacity dashboard', () => {
  it('reports capabilities as a list and never a total', async () => {
    const h = build({
      ...READY_SHOP,
      resources: [{ code: 'BAY-01', capabilities: ['GENERAL', 'LUBE', 'INSPECTION'] }, ...EIGHT.slice(1)],
    });
    const d = await h.service.capacityDashboard();
    expect(Object.keys(d)).not.toContain('totalCapacity');
    expect(d.capabilityNote).toContain('not added together');
    // One versatile bay appears in three rows and is still one position.
    expect(d.configuration.confirmedHeavyLiftPositions).toBe(8);
    expect(d.capabilityAvailability.find((c) => c.capability === 'LUBE')!.eligiblePositions).toBe(1);
  });

  it('lists the provisional identities by code', async () => {
    const h = build({ ...READY_SHOP });
    const d = await h.service.capacityDashboard();
    expect(d.configuration.provisionalIdentities).toHaveLength(8);
    expect(d.configuration.provisionalIdentities).toContain('BAY-01');
  });

  it('separates blockers from warnings', async () => {
    const h = build({
      resources: [...EIGHT, { code: 'OVF-01', capacityRole: 'UNVERIFIED' }],
      services: [{ code: 'OIL-01', requiredBayType: 'LUBE' }],
      validation: { ...VALID, fingerprint: 'fp' },
    });
    const d = await h.service.capacityDashboard();
    expect(d.scheduling.blockers.length).toBeGreaterThan(0);
    expect(d.scheduling.warnings.length).toBeGreaterThan(0);
    expect(d.scheduling.blockers.map((b) => b.label).join(' ')).not.toContain('Optional resources');
  });
});
