/**
 * CR-2026-108 Stage 5C §13/§14 — two different readiness questions.
 *
 * The earlier gate had one, and it was the wrong shape: it demanded a perfect
 * inventory before the resource engine could run at all. That confuses two
 * completely different bars.
 *
 *   READY FOR SHADOW      Is there enough configuration to learn something from a
 *                         diagnostic comparison? A shop with eight confirmed bays
 *                         and eight unclassified ones can absolutely be measured —
 *                         the results just carry a lower-bound caveat.
 *
 *   READY FOR PRODUCTION  Would it be safe for this engine to decide what a
 *                         customer is offered? A much higher bar, because being
 *                         wrong here turns into a vehicle nobody can service.
 *
 * Holding shadow to the production bar meant no evidence could be gathered until
 * the configuration was already perfect — which is backwards, because the evidence
 * is how you find out what still needs configuring.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Where the last shadow validation run is recorded. */
export const SHADOW_VALIDATION_KEY = 'resource_shadow_validation';

export interface ShadowValidationRecord {
  /** The configuration digest the run was measured against. */
  fingerprint: string;
  at: string;
  services: string[];
  slotsCompared: number;
  /** FIXED offered, resource model could not cover it. The dangerous direction. */
  oversold: number;
  undersold: number;
  incomplete: number;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ResourceReadiness {
  generatedAt: string;
  fingerprint: string;
  shadow: { ready: boolean; checks: ReadinessCheck[]; summary: string };
  production: { ready: boolean; checks: ReadinessCheck[]; summary: string };
  /** What is configured right now, so the answer can be read in context. */
  current: {
    capacityMode: string;
    maxConcurrentAppointments: number | null;
    durationSource: string;
    verifiedActivePositions: number;
    unverifiedResources: number;
    capabilityPositions: Record<string, number>;
  };
}

const POSITION_ROLES = ['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION'];

@Injectable()
export class ResourceReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async assess(siteId?: string, fingerprint?: string): Promise<ResourceReadiness> {
    const where = siteId ? { siteId } : {};
    const [resources, bookable, config, validationRow] = await Promise.all([
      this.prisma.workResource.findMany({
        where,
        select: {
          code: true, capacityRole: true, capacity: true, isActive: true, retiredAt: true,
          schedulingEnabled: true, resourceCategory: true,
          operationalStatus: { select: { status: true } },
          serviceCapabilities: { select: { capability: true } },
        },
      }),
      this.prisma.serviceType.findMany({
        where: { bookableOnline: true, isActive: true },
        select: { code: true, name: true, requiredBayType: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.businessRuleConfig.findMany({
        where: {
          ruleKey: { in: ['booking_capacity_mode', 'booking_max_concurrent_appointments', 'appointment_duration_source'] },
          effectiveTo: null,
        },
        select: { ruleKey: true, valueJson: true },
      }),
      this.prisma.businessRuleConfig.findFirst({
        where: { ruleKey: SHADOW_VALIDATION_KEY, effectiveTo: null },
        select: { valueJson: true },
      }),
    ]);

    const cfg = Object.fromEntries(config.map((c) => [c.ruleKey, c.valueJson]));
    const live = resources.filter((r) => !r.retiredAt);
    const usable = live.filter(
      (r) =>
        POSITION_ROLES.includes(String(r.capacityRole)) &&
        r.isActive &&
        r.schedulingEnabled &&
        (r.operationalStatus?.status ?? 'AVAILABLE') === 'AVAILABLE',
    );
    const unverified = live.filter(
      (r) => String(r.capacityRole) === 'UNVERIFIED' && r.isActive && String(r.resourceCategory) !== 'EXTERNAL',
    );
    const capabilityPositions: Record<string, number> = {};
    for (const r of usable) {
      for (const c of r.serviceCapabilities) {
        capabilityPositions[c.capability] = (capabilityPositions[c.capability] ?? 0) + r.capacity;
      }
    }
    const activePositions = usable.reduce((n, r) => n + r.capacity, 0);

    // --- READY FOR SHADOW ----------------------------------------------------
    // Deliberately lenient. The only real requirement is that there is something
    // to reason about; a caveat on the numbers is not a reason to refuse to learn.
    const shadowChecks: ReadinessCheck[] = [
      check(
        'positions-exist',
        'At least one confirmed vehicle position',
        activePositions > 0,
        activePositions > 0
          ? `${activePositions} confirmed position(s) are available now.`
          : 'No resource is classified as an available vehicle position, so there is nothing to reason about.',
      ),
      check(
        'capabilities-assigned',
        'At least one position says what work it can take',
        Object.keys(capabilityPositions).length > 0,
        Object.keys(capabilityPositions).length > 0
          ? `Capabilities in use: ${Object.keys(capabilityPositions).sort().join(', ')}.`
          : 'No confirmed position carries a capability, so every pool would be empty.',
      ),
      check(
        'inventory-loaded',
        'The resource inventory is readable',
        live.length > 0,
        `${live.length} live resource record(s).`,
      ),
    ];
    const shadowReady = shadowChecks.every((c) => c.passed);

    // --- READY FOR PRODUCTION RESOURCE_AWARE --------------------------------
    // Everything the CR listed, each as its own named check so a failure tells a
    // manager what to go and do rather than just "not ready".
    const unmapped = bookable.filter((s) => !s.requiredBayType);
    const missingPools = bookable
      .filter((s) => s.requiredBayType)
      .filter((s) => (capabilityPositions[s.requiredBayType!] ?? 0) === 0);
    const singlePools = bookable
      .filter((s) => s.requiredBayType)
      .filter((s) => (capabilityPositions[s.requiredBayType!] ?? 0) === 1);
    const validation = parseValidation(validationRow?.valueJson);
    const currentFingerprint = fingerprint ?? null;
    const validationMatches =
      !!validation && (!currentFingerprint || validation.fingerprint === currentFingerprint);

    const productionChecks: ReadinessCheck[] = [
      check(
        'no-unverified',
        'No material resource is still unclassified',
        unverified.length === 0,
        unverified.length === 0
          ? 'Every live resource has a confirmed capacity role.'
          : `${unverified.length} unclassified: ${unverified.map((r) => r.code).join(', ')}. ` +
            'Each contributes zero, so the engine would be reasoning about part of the shop.',
      ),
      check(
        'general-capacity',
        'General mechanical capacity is confirmed',
        (capabilityPositions.GENERAL ?? 0) > 0,
        (capabilityPositions.GENERAL ?? 0) > 0
          ? `${capabilityPositions.GENERAL} position(s) can take general work.`
          : 'No confirmed position carries GENERAL.',
      ),
      check(
        'inventory-non-zero',
        'Active resource inventory is non-zero',
        activePositions > 0,
        `${activePositions} confirmed position(s) available now.`,
      ),
      check(
        'services-mapped',
        'Every publicly bookable service resolves to a capability',
        unmapped.length === 0,
        unmapped.length === 0
          ? `All ${bookable.length} public service(s) name a required capability.`
          : `${unmapped.map((s) => s.code).join(', ')} have no required capability, so the engine cannot tell where they happen.`,
      ),
      check(
        'no-missing-pool',
        'No required specialty pool is empty',
        missingPools.length === 0,
        missingPools.length === 0
          ? 'Every capability a public service needs has at least one position.'
          : missingPools.map((s) => `${s.code} needs ${s.requiredBayType} and no position has it`).join('; ') + '.',
      ),
      check(
        'shadow-validated',
        'This exact configuration has passed shadow validation',
        validationMatches,
        validation
          ? validationMatches
            ? `Validated ${new Date(validation.at).toISOString().slice(0, 16).replace('T', ' ')} against ${validation.slotsCompared} slots (${validation.oversold} oversold, ${validation.undersold} undersold).`
            : `The last validation was against configuration ${validation.fingerprint}, and the shop is now ${currentFingerprint}. Re-run it.`
          : 'No shadow validation has been recorded. Run `pnpm booking:shadow-validate`.',
      ),
      check(
        'no-critical-mismatch',
        'No known critical resource mismatch',
        validationMatches && (validation?.oversold ?? 0) === 0,
        validation && validation.oversold > 0
          ? `The last run found ${validation.oversold} slot(s) the fixed limit offered that no eligible position could cover. ` +
            'Activating would not create that problem — it already exists — but it must be understood first.'
          : 'No slot was found where the fixed limit offered work the shop could not cover.',
      ),
    ];
    const productionReady = productionChecks.every((c) => c.passed);

    return {
      generatedAt: new Date().toISOString(),
      fingerprint: currentFingerprint ?? '(not supplied)',
      shadow: {
        ready: shadowReady,
        checks: shadowChecks,
        summary: shadowReady
          ? unverified.length > 0
            ? `Ready. ${unverified.length} resource(s) remain unclassified, so shadow figures are a LOWER BOUND — that is a caveat on the numbers, not a reason to withhold them.`
            : 'Ready, with a fully classified inventory.'
          : 'Not ready: ' + shadowChecks.filter((c) => !c.passed).map((c) => c.label).join('; ') + '.',
      },
      production: {
        ready: productionReady,
        checks: productionChecks,
        summary: productionReady
          ? 'All production preflight checks pass. Activation is a deliberate, separate decision.'
          : `${productionChecks.filter((c) => !c.passed).length} of ${productionChecks.length} checks fail — production stays FIXED.` +
            (singlePools.length > 0
              ? ` Note also: ${singlePools.map((s) => `${s.code} (${s.requiredBayType})`).join(', ')} rest on a single position.`
              : ''),
      },
      current: {
        capacityMode: typeof cfg.booking_capacity_mode === 'string' ? cfg.booking_capacity_mode : 'FIXED',
        maxConcurrentAppointments: typeof cfg.booking_max_concurrent_appointments === 'number' ? cfg.booking_max_concurrent_appointments : null,
        durationSource: typeof cfg.appointment_duration_source === 'string' ? cfg.appointment_duration_source : 'DEFAULT',
        verifiedActivePositions: activePositions,
        unverifiedResources: unverified.length,
        capabilityPositions,
      },
    };
  }

  /**
   * §22 — the capacity strip on Resources & Bays.
   *
   * Capability counts are returned as a LIST, never a total. There is no field
   * here that sums them, because the moment one exists somebody will read it as
   * shop capacity — and eight bays that each do three things would read as
   * twenty-four.
   */
  async capacityDashboard(siteId?: string) {
    const where = siteId ? { siteId } : {};
    const [resources, bookable, config] = await Promise.all([
      this.prisma.workResource.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        select: {
          code: true, name: true, capacityRole: true, capacity: true, isActive: true,
          retiredAt: true, schedulingEnabled: true, resourceCategory: true,
          operationalStatus: { select: { status: true, reason: true } },
          serviceCapabilities: { select: { capability: true } },
        },
      }),
      this.prisma.serviceType.findMany({
        where: { bookableOnline: true, isActive: true },
        select: { code: true, requiredBayType: true },
      }),
      this.prisma.businessRuleConfig.findMany({
        where: { ruleKey: { in: ['booking_capacity_mode', 'booking_max_concurrent_appointments'] }, effectiveTo: null },
        select: { ruleKey: true, valueJson: true },
      }),
    ]);

    const cfg = Object.fromEntries(config.map((c) => [c.ruleKey, c.valueJson]));
    const live = resources.filter((r) => !r.retiredAt);
    const status = (r: (typeof live)[number]) => r.operationalStatus?.status ?? 'AVAILABLE';
    const usable = (r: (typeof live)[number]) => r.isActive && r.schedulingEnabled && status(r) === 'AVAILABLE';
    const counted = live.filter((r) => ['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION'].includes(String(r.capacityRole)) && usable(r));

    const capabilityPositions: Record<string, number> = {};
    for (const r of counted) for (const c of r.serviceCapabilities) capabilityPositions[c.capability] = (capabilityPositions[c.capability] ?? 0) + r.capacity;

    // Every capability the shop could be asked for, including the ones nothing
    // currently provides — silence would read as "not asked", zero reads as
    // "asked, and there are none", and only the second is actionable.
    const asked = new Set<string>([...bookable.map((s) => s.requiredBayType).filter((c): c is string => !!c), ...Object.keys(capabilityPositions)]);
    const readiness = await this.assess(siteId);

    return {
      generatedAt: new Date().toISOString(),
      configuration: {
        verifiedActivePrimary: live.filter((r) => r.capacityRole === 'PRIMARY_SERVICE_POSITION' && usable(r)).reduce((n, r) => n + r.capacity, 0),
        verifiedActiveOverflow: live.filter((r) => r.capacityRole === 'OVERFLOW_SERVICE_POSITION' && usable(r)).reduce((n, r) => n + r.capacity, 0),
        unverifiedCandidates: live.filter((r) => r.capacityRole === 'UNVERIFIED' && r.isActive && String(r.resourceCategory) !== 'EXTERNAL').length,
        supportEquipment: live.filter((r) => r.capacityRole === 'SUPPORT_EQUIPMENT').length,
        placeholders: live.filter((r) => r.capacityRole === 'PLACEHOLDER').length,
        unavailableToday: live.filter((r) => status(r) !== 'AVAILABLE').map((r) => ({
          code: r.code, name: r.name, status: status(r), reason: r.operationalStatus?.reason ?? null,
        })),
        retired: resources.length - live.length,
      },
      capabilityAvailability: [...asked].sort().map((capability) => ({
        capability,
        eligiblePositions: capabilityPositions[capability] ?? 0,
        verified: (capabilityPositions[capability] ?? 0) > 0,
        requiredByPublicServices: bookable.filter((s) => s.requiredBayType === capability).map((s) => s.code),
      })),
      /** Said out loud because the table above invites exactly this mistake. */
      capabilityNote:
        'These are not added together. One bay that can do three kinds of work appears in three rows and is still one vehicle at a time.',
      scheduling: {
        productionModel: typeof cfg.booking_capacity_mode === 'string' && cfg.booking_capacity_mode !== 'FIXED' ? 'RESOURCE_AWARE' : 'FIXED',
        productionConcurrencyLimit: typeof cfg.booking_max_concurrent_appointments === 'number' ? cfg.booking_max_concurrent_appointments : null,
        shadowModel: 'RESOURCE_AWARE',
        resourceAwareProductionReady: readiness.production.ready,
        readinessSummary: readiness.production.summary,
        blockers: readiness.production.checks.filter((c) => !c.passed).map((c) => ({ label: c.label, detail: c.detail })),
      },
    };
  }

  /**
   * §14 — the guard. Called before `booking_capacity_mode` may become
   * RESOURCE_AWARE. Returns the blockers rather than throwing, so the caller can
   * decide whether to refuse or merely warn.
   */
  async productionActivationBlockers(siteId?: string, fingerprint?: string): Promise<string[]> {
    const r = await this.assess(siteId, fingerprint);
    return r.production.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.detail}`);
  }
}

function check(id: string, label: string, passed: boolean, detail: string): ReadinessCheck {
  return { id, label, passed, detail };
}

function parseValidation(v: unknown): ShadowValidationRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.fingerprint !== 'string' || typeof o.at !== 'string') return null;
  return {
    fingerprint: o.fingerprint,
    at: o.at,
    services: Array.isArray(o.services) ? (o.services as string[]) : [],
    slotsCompared: typeof o.slotsCompared === 'number' ? o.slotsCompared : 0,
    oversold: typeof o.oversold === 'number' ? o.oversold : 0,
    undersold: typeof o.undersold === 'number' ? o.undersold : 0,
    incomplete: typeof o.incomplete === 'number' ? o.incomplete : 0,
  };
}
