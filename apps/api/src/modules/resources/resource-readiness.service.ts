/**
 * CR-2026-108 §3/§7/§8 — two readiness questions, and the right thing gating each.
 *
 *   SHADOW READY      Can the resource-aware model run for diagnostics? A low bar.
 *                     Figures may carry a lower-bound caveat; that is a caveat on
 *                     the numbers, not a reason to withhold them.
 *
 *   PRODUCTION READY  Would it be safe for this engine to decide what a customer
 *                     is offered? Gated on ONE thing: can every currently bookable
 *                     service actually be fulfilled by a verified position?
 *
 * WHAT CHANGED, AND WHY IT WAS WRONG BEFORE
 *
 * The first version blocked production on "any unclassified resource". That is too
 * strict, and strict in a way that never ends: an UNVERIFIED resource contributes
 * ZERO, so ignoring it produces a CONSERVATIVE model. It cannot cause overbooking —
 * the worst it can do is under-offer capacity the shop actually has. Blocking on it
 * meant a jack nobody had labelled could veto a scheduling model that was already
 * safe, forever.
 *
 * So the two are now separated properly:
 *
 *   BLOCKER   A customer can book something the shop has no verified way to do.
 *   WARNING   A resource contributes zero and no public service depends on it.
 *
 * Warnings stay loud. They just do not hold the gate shut.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
// Pure function, no Nest dependency. Imported rather than reimplemented so the
// digest the readiness gate compares is byte-for-byte the one the shadow run
// stamped — two implementations of "has the configuration changed" would drift,
// and the failure mode is a stale validation silently counting as current.
import { fingerprintOf } from '../scheduling/availability/resource-availability.service';

/** Where the last shadow validation run is recorded. */
export const SHADOW_VALIDATION_KEY = 'resource_shadow_validation';

export interface ShadowValidationRecord {
  fingerprint: string;
  at: string;
  services: string[];
  slotsCompared: number;
  /** FIXED offered, the resource model could not cover it. The dangerous direction. */
  oversold: number;
  undersold: number;
  incomplete: number;
}

export type FindingSeverity = 'BLOCKER' | 'WARNING' | 'OK';

export interface ReadinessFinding {
  id: string;
  label: string;
  severity: FindingSeverity;
  detail: string;
}

/** §8 — the activation gate, service by service. */
export interface PublicServiceReadiness {
  code: string;
  name: string;
  requiredCapability: string | null;
  verifiedEligiblePositions: number;
  status: 'READY' | 'INCOMPLETE';
  /**
   * One position is a valid answer when one is what exists (§6). It is reported
   * as an operational risk, never as evidence a second one ought to exist.
   */
  singlePointOfFailure: boolean;
  detail: string;
}

export interface ResourceReadiness {
  generatedAt: string;
  fingerprint: string;
  shadow: { ready: boolean; findings: ReadinessFinding[]; summary: string };
  production: {
    ready: boolean;
    findings: ReadinessFinding[];
    blockers: ReadinessFinding[];
    warnings: ReadinessFinding[];
    summary: string;
  };
  /** §8 — every customer-bookable service and whether it has a verified path. */
  publicServices: PublicServiceReadiness[];
  current: {
    capacityMode: string;
    maxConcurrentAppointments: number | null;
    durationSource: string;
    verifiedActivePositions: number;
    /** §1 — counted positions nobody has physically identified yet. */
    provisionalIdentities: number;
    /** §3/§4 — internal, unclassified, contributing zero. A warning, not a gate. */
    optionalUnverifiedResources: number;
    /** §4 — excluded from the internal total entirely, not merely unblocking. */
    externalResources: number;
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
          code: true, name: true, capacityRole: true, capacity: true, isActive: true,
          retiredAt: true, schedulingEnabled: true, resourceCategory: true,
          supportsSedan: true, supportsSuv: true, identityConfirmedAt: true, liftType: true,
          operationalStatus: { select: { status: true } },
          serviceCapabilities: { select: { capability: true } },
        },
      }),
      this.prisma.serviceType.findMany({
        where: { bookableOnline: true, isActive: true },
        select: { code: true, name: true, customerFacingName: true, requiredBayType: true },
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

    // §4 — EXTERNAL is somebody else's resource. It contributes zero INTERNAL
    // capacity and is excluded from the unresolved-internal total entirely; it is
    // not "an unverified resource that happens not to block", it is out of scope.
    const isExternal = (r: (typeof live)[number]) => String(r.resourceCategory) === 'EXTERNAL';
    const internal = live.filter((r) => !isExternal(r));

    const status = (r: (typeof live)[number]) => r.operationalStatus?.status ?? 'AVAILABLE';
    const usable = (r: (typeof live)[number]) =>
      POSITION_ROLES.includes(String(r.capacityRole)) && r.isActive && r.schedulingEnabled && status(r) === 'AVAILABLE';

    const counted = internal.filter(usable);
    const capabilityPositions: Record<string, number> = {};
    for (const r of counted) {
      for (const c of r.serviceCapabilities) {
        capabilityPositions[c.capability] = (capabilityPositions[c.capability] ?? 0) + r.capacity;
      }
    }
    const activePositions = counted.reduce((n, r) => n + r.capacity, 0);
    const optionalUnverified = internal.filter((r) => String(r.capacityRole) === 'UNVERIFIED' && r.isActive);
    const provisional = counted.filter((r) => r.identityConfirmedAt == null);
    // Compute the CURRENT digest rather than trusting a caller to supply one.
    // The earlier version passed the check whenever no fingerprint was given —
    // which is every call from the endpoint — so a validation run from before a
    // bay was commissioned would have counted as current.
    //
    // Fingerprinted over EVERY row, retired included, because that is exactly
    // what `ResourceAvailabilityService.snapshot()` does. A different row set
    // would produce a different digest from identical configuration, and the gate
    // would then never accept any validation at all.
    const currentFingerprint = fingerprint ?? fingerprintOf(
      resources.map((r) => ({
        id: r.code,
        code: r.code,
        capacityRole: String(r.capacityRole),
        capabilities: r.serviceCapabilities.map((c) => c.capability),
        capacity: r.capacity,
        isActive: r.isActive,
        retired: r.retiredAt != null,
        schedulingEnabled: r.schedulingEnabled,
        operationalStatus: r.operationalStatus?.status ? String(r.operationalStatus.status) : 'AVAILABLE',
        supportsSedan: r.supportsSedan,
        supportsSuv: r.supportsSuv,
        liftType: r.liftType,
      })),
    );
    const validation = parseValidation(validationRow?.valueJson);
    const validationMatches = !!validation && validation.fingerprint === currentFingerprint;

    // --- §8 — the gate: can each bookable service actually be fulfilled? ------
    const publicServices: PublicServiceReadiness[] = bookable.map((s) => {
      const capability = s.requiredBayType;
      // A service with no required capability can run on any position. That is a
      // catalogue gap worth reporting, but it does not make the work impossible.
      const eligible = capability ? (capabilityPositions[capability] ?? 0) : activePositions;
      const ready = eligible > 0;
      return {
        code: s.code,
        name: s.customerFacingName?.trim() || s.name,
        requiredCapability: capability,
        verifiedEligiblePositions: eligible,
        status: ready ? ('READY' as const) : ('INCOMPLETE' as const),
        // §6 — one position is a valid answer when one is what exists.
        singlePointOfFailure: ready && eligible === 1,
        detail: ready
          ? capability
            ? `${eligible} verified position${eligible === 1 ? '' : 's'} can do ${capability} work.`
            : `No particular kind of position required; ${eligible} available.`
          : `No verified position carries ${capability}. A customer can book this and the shop has no confirmed way to do it.`,
      };
    });
    const incompleteServices = publicServices.filter((s) => s.status === 'INCOMPLETE');

    // --- contradictory configuration ------------------------------------------
    // A counted position that cannot actually take a vehicle, or that says it can
    // work but never says on what. Both are live faults, not missing information.
    const contradictory = counted.filter((r) => (!r.supportsSedan && !r.supportsSuv) || r.serviceCapabilities.length === 0);

    // --- SHADOW READY ----------------------------------------------------------
    const shadowFindings: ReadinessFinding[] = [
      finding(
        'positions-exist',
        'At least one confirmed vehicle position',
        activePositions > 0 ? 'OK' : 'BLOCKER',
        activePositions > 0
          ? `${activePositions} confirmed position(s) available now.`
          : 'No resource is classified as an available vehicle position, so there is nothing to reason about.',
      ),
      finding(
        'capabilities-assigned',
        'At least one position says what work it can take',
        Object.keys(capabilityPositions).length > 0 ? 'OK' : 'BLOCKER',
        Object.keys(capabilityPositions).length > 0
          ? `Capabilities in use: ${Object.keys(capabilityPositions).sort().join(', ')}.`
          : 'No confirmed position carries a capability, so every pool would be empty.',
      ),
    ];
    const shadowReady = !shadowFindings.some((f) => f.severity === 'BLOCKER');

    // --- PRODUCTION READY ------------------------------------------------------
    const productionFindings: ReadinessFinding[] = [
      finding(
        'public-services-fulfillable',
        'Every customer-bookable service has a verified resource path',
        incompleteServices.length === 0 ? 'OK' : 'BLOCKER',
        incompleteServices.length === 0
          ? `All ${publicServices.length} public service(s) resolve to at least one verified position.`
          : incompleteServices
              .map((s) => `${s.code} needs ${s.requiredCapability} and no verified position has it`)
              .join('; ') + '.',
      ),
      finding(
        'inventory-non-zero',
        'Active resource inventory is non-zero',
        activePositions > 0 ? 'OK' : 'BLOCKER',
        `${activePositions} confirmed position(s) available now.`,
      ),
      finding(
        'no-contradictory-configuration',
        'No active position has contradictory configuration',
        contradictory.length === 0 ? 'OK' : 'BLOCKER',
        contradictory.length === 0
          ? 'Every counted position accepts a vehicle class and declares what work it takes.'
          : contradictory
              .map((r) =>
                !r.supportsSedan && !r.supportsSuv
                  ? `${r.code} accepts neither sedans nor SUVs`
                  : `${r.code} is counted as a position but declares no capability`,
              )
              .join('; ') + '.',
      ),
      finding(
        'shadow-validated',
        'This exact configuration has passed shadow validation',
        validationMatches ? 'OK' : 'BLOCKER',
        validation
          ? validationMatches
            ? `Validated ${validation.at.slice(0, 16).replace('T', ' ')} over ${validation.slotsCompared} slots (${validation.oversold} oversold, ${validation.undersold} undersold, ${validation.incomplete} incomplete).`
            : `The last validation was against configuration ${validation.fingerprint}; the shop is now ${currentFingerprint}. Re-run \`pnpm booking:shadow-validate\`.`
          : 'No shadow validation has been recorded. Run `pnpm booking:shadow-validate`.',
      ),
      finding(
        'no-unfulfillable-offer',
        'No slot is offered that the shop cannot cover',
        validationMatches && (validation?.oversold ?? 0) === 0 ? 'OK' : validationMatches ? 'BLOCKER' : 'WARNING',
        validation && validation.oversold > 0
          ? `The last run found ${validation.oversold} slot(s) the fixed limit offered that no eligible position could cover. ` +
            'Activating would not create that problem — it already exists — but it must be understood first.'
          : 'No slot was found where the fixed limit offered work the shop could not cover.',
      ),
      finding(
        'shadow-evaluable',
        'Shadow evaluation resolves for every public service',
        validationMatches && (validation?.incomplete ?? 0) === 0 ? 'OK' : 'BLOCKER',
        validation && validation.incomplete > 0
          ? `${validation.incomplete} slot(s) could not be evaluated because a required capability is unconfigured. ` +
            'That is a configuration gap rather than a capacity finding, but the engine cannot be trusted with a decision it cannot make.'
          : 'Every public service resolved to a capability the resource model could evaluate.',
      ),

      // --- warnings: real, loud, and not a gate ------------------------------
      finding(
        'optional-unverified',
        'Optional resources remain unclassified',
        optionalUnverified.length === 0 ? 'OK' : 'WARNING',
        optionalUnverified.length === 0
          ? 'Every internal resource has a confirmed capacity role.'
          : `${optionalUnverified.length} internal resource(s) contribute ZERO: ${optionalUnverified.map((r) => r.code).join(', ')}. ` +
            'Ignoring them makes the model conservative — it can under-offer capacity the shop has, never over-offer it — ' +
            'so this does not block activation. Classify them to recover that capacity.',
      ),
      finding(
        'provisional-identities',
        'Position identities are provisional',
        provisional.length === 0 ? 'OK' : 'WARNING',
        provisional.length === 0
          ? 'Every counted position has been physically confirmed.'
          : `${provisional.length} counted position(s) were mapped from names and codes, not confirmed in the building: ` +
            `${provisional.map((r) => r.code).join(', ')}. The COUNT is management-confirmed; which row is which bay is not.`,
      ),
      finding(
        'single-point-of-failure',
        'Some services rest on a single position',
        publicServices.some((s) => s.singlePointOfFailure) ? 'WARNING' : 'OK',
        publicServices.some((s) => s.singlePointOfFailure)
          ? publicServices
              .filter((s) => s.singlePointOfFailure)
              .map((s) => `${s.code} (${s.requiredCapability})`)
              .join(', ') +
            ' run on one verified position. That is an operational risk to know about, not evidence a second one exists.'
          : 'No public service depends on a single position.',
      ),
    ];

    const blockers = productionFindings.filter((f) => f.severity === 'BLOCKER');
    const warnings = productionFindings.filter((f) => f.severity === 'WARNING');
    const productionReady = blockers.length === 0;

    return {
      generatedAt: new Date().toISOString(),
      fingerprint: currentFingerprint,
      shadow: {
        ready: shadowReady,
        findings: shadowFindings,
        summary: shadowReady
          ? optionalUnverified.length > 0
            ? `Ready. ${optionalUnverified.length} resource(s) remain unclassified, so shadow figures are a LOWER BOUND — a caveat on the numbers, not a reason to withhold them.`
            : 'Ready, with a fully classified inventory.'
          : 'Not ready: ' + shadowFindings.filter((f) => f.severity === 'BLOCKER').map((f) => f.label).join('; ') + '.',
      },
      production: {
        ready: productionReady,
        findings: productionFindings,
        blockers,
        warnings,
        summary: productionReady
          ? `All safety checks pass${warnings.length > 0 ? `, with ${warnings.length} warning(s) that do not affect safety` : ''}. Activation remains a deliberate, separate decision.`
          : `${blockers.length} blocker(s): ${blockers.map((b) => b.label).join('; ')}.` +
            (warnings.length > 0 ? ` (${warnings.length} warning(s) are NOT blocking.)` : ''),
      },
      publicServices,
      current: {
        capacityMode: typeof cfg.booking_capacity_mode === 'string' ? cfg.booking_capacity_mode : 'FIXED',
        maxConcurrentAppointments:
          typeof cfg.booking_max_concurrent_appointments === 'number' ? cfg.booking_max_concurrent_appointments : null,
        durationSource: typeof cfg.appointment_duration_source === 'string' ? cfg.appointment_duration_source : 'DEFAULT',
        verifiedActivePositions: activePositions,
        provisionalIdentities: provisional.length,
        optionalUnverifiedResources: optionalUnverified.length,
        externalResources: live.filter(isExternal).length,
        capabilityPositions,
      },
    };
  }

  /**
   * §14 — the capacity strip on Resources & Bays.
   *
   * Capability counts are a LIST, never a total. The moment a total exists
   * somebody reads it as shop capacity, and eight bays that each do three things
   * would read as twenty-four.
   */
  async capacityDashboard(siteId?: string) {
    const where = siteId ? { siteId } : {};
    const [resources, bookable] = await Promise.all([
      this.prisma.workResource.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        select: {
          code: true, name: true, capacityRole: true, capacity: true, isActive: true,
          retiredAt: true, schedulingEnabled: true, resourceCategory: true, identityConfirmedAt: true,
          operationalStatus: { select: { status: true, reason: true } },
          serviceCapabilities: { select: { capability: true } },
        },
      }),
      this.prisma.serviceType.findMany({
        where: { bookableOnline: true, isActive: true },
        select: { code: true, requiredBayType: true },
      }),
    ]);

    const live = resources.filter((r) => !r.retiredAt);
    const internal = live.filter((r) => String(r.resourceCategory) !== 'EXTERNAL');
    const status = (r: (typeof live)[number]) => r.operationalStatus?.status ?? 'AVAILABLE';
    const usable = (r: (typeof live)[number]) => r.isActive && r.schedulingEnabled && status(r) === 'AVAILABLE';
    const counted = internal.filter((r) => POSITION_ROLES.includes(String(r.capacityRole)) && usable(r));

    const capabilityPositions: Record<string, number> = {};
    for (const r of counted) {
      for (const c of r.serviceCapabilities) capabilityPositions[c.capability] = (capabilityPositions[c.capability] ?? 0) + r.capacity;
    }
    const asked = new Set<string>([
      ...bookable.map((s) => s.requiredBayType).filter((c): c is string => !!c),
      ...Object.keys(capabilityPositions),
    ]);
    const readiness = await this.assess(siteId);

    return {
      generatedAt: new Date().toISOString(),
      configuration: {
        confirmedHeavyLiftPositions: internal
          .filter((r) => r.capacityRole === 'PRIMARY_SERVICE_POSITION' && usable(r))
          .reduce((n, r) => n + r.capacity, 0),
        verifiedActiveOverflow: internal
          .filter((r) => r.capacityRole === 'OVERFLOW_SERVICE_POSITION' && usable(r))
          .reduce((n, r) => n + r.capacity, 0),
        optionalUnverified: internal.filter((r) => r.capacityRole === 'UNVERIFIED' && r.isActive).length,
        supportEquipment: internal.filter((r) => r.capacityRole === 'SUPPORT_EQUIPMENT').length,
        placeholders: internal.filter((r) => r.capacityRole === 'PLACEHOLDER').length,
        /** §4 — out of scope for internal capacity, not merely unblocking. */
        external: live.filter((r) => String(r.resourceCategory) === 'EXTERNAL').length,
        /** §1 — counted, but mapped from names rather than confirmed in the building. */
        provisionalIdentities: counted.filter((r) => r.identityConfirmedAt == null).map((r) => r.code),
        unavailableToday: internal
          .filter((r) => status(r) !== 'AVAILABLE')
          .map((r) => ({ code: r.code, name: r.name, status: status(r), reason: r.operationalStatus?.reason ?? null })),
        retired: resources.length - live.length,
      },
      capabilityAvailability: [...asked].sort().map((capability) => ({
        capability,
        eligiblePositions: capabilityPositions[capability] ?? 0,
        verified: (capabilityPositions[capability] ?? 0) > 0,
        requiredByPublicServices: bookable.filter((s) => s.requiredBayType === capability).map((s) => s.code),
      })),
      capabilityNote:
        'These are not added together. One bay that can do three kinds of work appears in three rows and is still one vehicle at a time.',
      publicServices: readiness.publicServices,
      scheduling: {
        customerCatalogueServices: bookable.length,
        productionModel: readiness.current.capacityMode === 'FIXED' ? 'FIXED' : 'RESOURCE_AWARE',
        productionConcurrencyLimit: readiness.current.maxConcurrentAppointments,
        productionDurationSource: readiness.current.durationSource,
        shadowModel: 'RESOURCE_AWARE',
        shadowReady: readiness.shadow.ready,
        resourceAwareProductionReady: readiness.production.ready,
        readinessSummary: readiness.production.summary,
        blockers: readiness.production.blockers.map((f) => ({ label: f.label, detail: f.detail })),
        warnings: readiness.production.warnings.map((f) => ({ label: f.label, detail: f.detail })),
      },
    };
  }

  /**
   * §14 — the guard. Called before `booking_capacity_mode` may become
   * RESOURCE_AWARE. Returns BLOCKERS only: a warning describes capacity the model
   * conservatively ignores, and ignoring capacity cannot overbook anyone.
   */
  async productionActivationBlockers(siteId?: string, fingerprint?: string): Promise<string[]> {
    const r = await this.assess(siteId, fingerprint);
    return r.production.blockers.map((f) => `${f.label}: ${f.detail}`);
  }
}

function finding(id: string, label: string, severity: FindingSeverity, detail: string): ReadinessFinding {
  return { id, label, severity, detail };
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
