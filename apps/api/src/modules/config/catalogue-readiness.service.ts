/**
 * CR-2026-108 Stage 4B — the Catalogue Readiness Audit.
 *
 * Answers one question: which services are safe, understandable and operationally
 * suitable for customer self-service booking?
 *
 * STRICTLY READ-ONLY. It writes nothing — not `bookableOnline`, not a name, not a
 * duration. It exists so a person decides, with the evidence in front of them,
 * rather than the system quietly enabling whatever happens to look complete. A
 * service with a perfect name and an unknowable three-hour diagnostic scope is
 * still the wrong thing to put on a public page.
 *
 * Readiness is CATEGORICAL with explicit reasons, never a 0-100 score. A score
 * would average away the one fact that disqualifies a service.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { BOOKING_RULE_KEYS, bookingRulesFromRows } from '../public-booking/booking.config';

export type Readiness = 'READY_FOR_REVIEW' | 'NEEDS_CONFIGURATION' | 'NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE';

export interface ReadinessFlag {
  /** Stable code so the UI can filter and tests can assert. */
  code: string;
  severity: 'BLOCKER' | 'WARNING' | 'INFO';
  message: string;
}

/**
 * Timing evidence, split by origin. Never combined: the historical import
 * describes the legacy job sheet, not this platform, and presenting the two as
 * one number would state a performance fact the platform has not earned.
 */
export interface DurationEvidence {
  source: 'LIVE_PLATFORM' | 'HISTORICAL_IMPORT';
  sampleCount: number;
  medianMinutes: number | null;
  p75Minutes: number | null;
  p90Minutes: number | null;
  /** First/last observation, so a reader can see how stale it is. */
  from: string | null;
  to: string | null;
  /** True when the sample is too small to support any conclusion. */
  insufficient: boolean;
}

export interface ServiceReadinessRow {
  // --- identity ---
  id: string;
  code: string;
  name: string;
  customerFacingName: string | null;
  /** What a customer would actually see today. */
  effectiveCustomerName: string;
  isActive: boolean;
  isExternal: boolean;
  family: string;
  // --- booking configuration ---
  bookableOnline: boolean;
  appointmentOnly: boolean;
  quickService: boolean;
  durationSource: 'CATALOGUE' | 'DEFAULT';
  baseDurationMinutes: number | null;
  bookingBufferMinutes: number;
  /** What the engine would actually plan with today. */
  effectivePlannedMinutes: number;
  usesFallbackDuration: boolean;
  /** Duration + buffer: what the slot would occupy. */
  schedulingOccupancyMinutes: number;
  // --- operational requirements ---
  requiredSkillCode: string | null;
  requiredBayType: string | null;
  canUseOverflow: boolean;
  canUseLightSlot: boolean;
  requiresMileage: boolean;
  // --- catalogue relationships (existing model only) ---
  componentRoles: string[];
  /** Derived from the KPI component role — the only relationship data that exists. */
  catalogueRole: 'STANDALONE' | 'PACKAGE_CORE' | 'PACKAGE_COMPONENT' | 'MAJOR_ADDITIONAL_WORK';
  // --- evidence ---
  evidence: DurationEvidence[];
  // --- verdict ---
  readiness: Readiness;
  reasons: string[];
  flags: ReadinessFlag[];
  /** Offered by /book right now, under whichever mode is configured. */
  currentlyOfferedToCustomers: boolean;
  /** Only a suggestion; nothing is written. */
  proposedCustomerFacingName: string | null;
}

export interface CatalogueReadinessReport {
  generatedAt: string;
  enforcementEnabled: boolean;
  durationSource: 'CATALOGUE' | 'DEFAULT';
  defaultDurationMinutes: number;
  totals: {
    activeServices: number;
    currentlyOffered: number;
    bookableOnline: number;
    readyForReview: number;
    needsConfiguration: number;
    notSuitable: number;
  };
  evidenceSummary: {
    livePlatformOrders: number;
    historicalImportOrders: number;
    historicalImportLinkedToServices: number;
    note: string;
  };
  services: ServiceReadinessRow[];
  proposedStartingSet: Array<{
    code: string;
    proposedCustomerFacingName: string;
    durationMinutes: number;
    proposedBufferMinutes: number;
    requiredBayType: string | null;
    requiredSkillCode: string | null;
    readiness: Readiness;
    reason: string;
  }>;
  deliberatelyExcluded: Array<{ code: string; name: string; reason: string }>;
}

/** Words that carry no distinguishing meaning when comparing service names. */
const GENERIC_TOKENS = new Set([
  'service', 'replacement', 'replace', 'change', 'repair', 'work', 'system',
  'and', 'or', 'the', 'a', 'of', 'vehicle', 'car',
]);

/** Tokens that read as internal shorthand rather than something a customer says. */
const JARGON_TOKENS = ['pkg', 'int', 'ext', 'misc', 'tbd', 'n/a', 'std', 'asm', 'r&r', 'lof'];

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !GENERIC_TOKENS.has(t))
      // Crude singular/plural fold: 'Shocks Replacement' and 'Shock / Strut
      // Replacement' are the same job to a customer, and would not compare
      // without it.
      .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)),
  );
}

/** Two services a customer could not tell apart. */
function looksLikeDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((t) => b.has(t));
  if (shared.length === 0) return false;
  // Either one name's distinctive words are wholly contained in the other, or
  // they overlap more than they differ.
  const subset = shared.length === Math.min(a.size, b.size);
  const jaccard = shared.length / new Set([...a, ...b]).size;
  return subset || jaccard >= 0.5;
}

@Injectable()
export class CatalogueReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async audit(): Promise<CatalogueReadinessReport> {
    const site = await this.prisma.site.findFirst({ select: { id: true } });
    const ruleRows = await this.prisma.businessRuleConfig.findMany({
      where: { ruleKey: { in: [...BOOKING_RULE_KEYS] }, effectiveTo: null, OR: [{ siteId: site?.id ?? null }, { siteId: null }] },
      select: { ruleKey: true, valueJson: true, siteId: true },
    });
    const booking = bookingRulesFromRows(ruleRows);
    const defaultDurationRow = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'default_appointment_duration_minutes', effectiveTo: null },
      select: { valueJson: true },
    });
    const defaultDuration = typeof defaultDurationRow?.valueJson === 'number' ? defaultDurationRow.valueJson : 80;

    const services = await this.prisma.serviceType.findMany({
      where: { isActive: true },
      orderBy: [{ family: 'asc' }, { code: 'asc' }],
      select: {
        id: true, code: true, name: true, customerFacingName: true, family: true,
        baseDurationMinutes: true, bookingBufferMinutes: true, bookableOnline: true,
        appointmentOnly: true, quickService: true, isExternal: true, isActive: true,
        requiredSkillCode: true, requiredBayType: true, canUseOverflow: true,
        canUseLightSlot: true, requiresMileage: true,
        kpiComponents: { where: { isActive: true }, select: { componentRole: true } },
      },
    });

    const evidenceByService = await this.durationEvidence();
    const importTotals = await this.importEvidenceTotals();

    // Effective customer names first — duplicate detection compares what a
    // customer would actually READ, not the internal code.
    // Structural unsuitability is decided FIRST: a service that will never be
    // offered cannot make another service ambiguous. Flagging "Oil Change" as
    // confusable with "Oil Filter Change" is noise when the latter is a package
    // component that no customer will ever be shown.
    const structural = new Map(services.map((s) => [s.code, this.structuralExclusion(s, this.catalogueRole(s.kpiComponents.map((c) => String(c.componentRole))))]));
    const effectiveNames = services
      .filter((s) => !structural.get(s.code))
      .map((s) => ({ code: s.code, name: (s.customerFacingName?.trim() || s.name), tokens: nameTokens(s.customerFacingName?.trim() || s.name) }));

    const rows: ServiceReadinessRow[] = services.map((s) => {
      const effectiveCustomerName = s.customerFacingName?.trim() || s.name;
      const hasDuration = typeof s.baseDurationMinutes === 'number' && s.baseDurationMinutes > 0;
      const usesFallbackDuration = booking.durationSource !== 'CATALOGUE' || !hasDuration;
      const effectivePlannedMinutes = usesFallbackDuration ? defaultDuration : s.baseDurationMinutes!;
      const roles = s.kpiComponents.map((c) => String(c.componentRole));
      const catalogueRole = this.catalogueRole(roles);
      const flags: ReadinessFlag[] = [];
      const reasons: string[] = [];

      // --- duration quality -------------------------------------------------
      if (!hasDuration) {
        flags.push({ code: 'DURATION_MISSING', severity: 'BLOCKER', message: 'No catalogue duration — a slot could not be sized from the catalogue.' });
      } else if (s.baseDurationMinutes! >= 180) {
        flags.push({ code: 'DURATION_LONG', severity: 'WARNING', message: `${s.baseDurationMinutes} minutes is a long, likely variable job — heuristic, not a business rule.` });
      }
      if (usesFallbackDuration && hasDuration) {
        flags.push({ code: 'DURATION_FALLBACK_IN_USE', severity: 'INFO', message: `Planning currently uses the ${defaultDuration}-minute default, not this service's ${s.baseDurationMinutes} minutes (appointment_duration_source=DEFAULT).` });
      }
      if (s.bookingBufferMinutes > 0 && hasDuration && s.bookingBufferMinutes > s.baseDurationMinutes!) {
        flags.push({ code: 'BUFFER_DISPROPORTIONATE', severity: 'WARNING', message: `Buffer (${s.bookingBufferMinutes}m) exceeds the service duration (${s.baseDurationMinutes}m).` });
      }

      // --- customer-facing quality -----------------------------------------
      const lower = effectiveCustomerName.toLowerCase();
      if (!s.customerFacingName) {
        const jargon = JARGON_TOKENS.some((j) => lower.split(/[^a-z0-9/&]+/).includes(j));
        flags.push({
          code: jargon ? 'NAME_INTERNAL_JARGON' : 'NAME_NOT_SET',
          severity: jargon ? 'BLOCKER' : 'INFO',
          message: jargon
            ? `"${effectiveCustomerName}" reads as internal shorthand; a customer would not recognise it.`
            : `No customer-facing name set; "${s.name}" would be shown. Review that it reads as a customer outcome.`,
        });
      }
      const similar = effectiveNames.filter((o) => o.code !== s.code && looksLikeDuplicate(o.tokens, nameTokens(effectiveCustomerName)));
      if (similar.length > 0) {
        flags.push({
          code: 'NAME_AMBIGUOUS',
          severity: 'WARNING',
          message: `A customer could not tell this apart from: ${similar.map((o) => `${o.name} (${o.code})`).join(', ')}.`,
        });
      }

      // --- evidence ---------------------------------------------------------
      const evidence = evidenceByService.get(s.code) ?? this.emptyEvidence();

      // --- readiness --------------------------------------------------------
      let readiness: Readiness;
      const structuralReason = structural.get(s.code);
      if (structuralReason) {
        readiness = 'NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE';
        reasons.push(structuralReason);
      } else if (flags.some((f) => f.severity === 'BLOCKER')) {
        readiness = 'NEEDS_CONFIGURATION';
        reasons.push(...flags.filter((f) => f.severity === 'BLOCKER').map((f) => f.message));
      } else if (flags.some((f) => f.code === 'NAME_AMBIGUOUS' || f.code === 'DURATION_LONG')) {
        readiness = 'NEEDS_CONFIGURATION';
        reasons.push(...flags.filter((f) => f.severity === 'WARNING').map((f) => f.message));
      } else {
        readiness = 'READY_FOR_REVIEW';
        reasons.push('Routine work with a configured duration and understandable name. Still requires explicit approval.');
      }

      return {
        id: s.id, code: s.code, name: s.name,
        customerFacingName: s.customerFacingName,
        effectiveCustomerName,
        isActive: s.isActive, isExternal: s.isExternal, family: s.family,
        bookableOnline: s.bookableOnline,
        appointmentOnly: s.appointmentOnly,
        quickService: s.quickService,
        durationSource: booking.durationSource,
        baseDurationMinutes: s.baseDurationMinutes,
        bookingBufferMinutes: s.bookingBufferMinutes,
        effectivePlannedMinutes,
        usesFallbackDuration,
        schedulingOccupancyMinutes: effectivePlannedMinutes + s.bookingBufferMinutes,
        requiredSkillCode: s.requiredSkillCode,
        requiredBayType: s.requiredBayType,
        canUseOverflow: s.canUseOverflow,
        canUseLightSlot: s.canUseLightSlot,
        requiresMileage: s.requiresMileage,
        componentRoles: roles,
        catalogueRole,
        evidence,
        readiness,
        reasons,
        flags,
        // What /book offers TODAY, under whichever mode is configured.
        currentlyOfferedToCustomers:
          s.isActive && !s.isExternal && !booking.excludedServiceCodes.includes(s.code) &&
          (!booking.enforceOnlineBookable || s.bookableOnline),
        proposedCustomerFacingName: s.customerFacingName ? null : this.proposeName(s.name),
      };
    });

    const ready = rows.filter((r) => r.readiness === 'READY_FOR_REVIEW');

    return {
      generatedAt: new Date().toISOString(),
      enforcementEnabled: booking.enforceOnlineBookable,
      durationSource: booking.durationSource,
      defaultDurationMinutes: defaultDuration,
      totals: {
        activeServices: rows.length,
        currentlyOffered: rows.filter((r) => r.currentlyOfferedToCustomers).length,
        bookableOnline: rows.filter((r) => r.bookableOnline).length,
        readyForReview: ready.length,
        needsConfiguration: rows.filter((r) => r.readiness === 'NEEDS_CONFIGURATION').length,
        notSuitable: rows.filter((r) => r.readiness === 'NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE').length,
      },
      evidenceSummary: importTotals,
      services: rows,
      proposedStartingSet: ready.map((r) => ({
        code: r.code,
        proposedCustomerFacingName: r.customerFacingName ?? r.proposedCustomerFacingName ?? r.name,
        durationMinutes: r.baseDurationMinutes ?? defaultDuration,
        // Deliberately 0: a buffer must come from observed turnaround, and there
        // is no per-service evidence to derive one from (see evidenceSummary).
        proposedBufferMinutes: 0,
        requiredBayType: r.requiredBayType,
        requiredSkillCode: r.requiredSkillCode,
        readiness: r.readiness,
        reason: r.reasons[0] ?? '',
      })),
      deliberatelyExcluded: rows
        .filter((r) => r.readiness !== 'READY_FOR_REVIEW')
        .map((r) => ({ code: r.code, name: r.effectiveCustomerName, reason: r.reasons[0] ?? '' })),
    };
  }

  /**
   * Reasons a service is inherently unfit for DIRECT customer booking, regardless
   * of how well its record is filled in. These are structural — better data would
   * not change them — which is why they are decided before anything else and why
   * they never write to `bookableOnline`: the verdict is advice, not an action.
   */
  private structuralExclusion(
    s: { isExternal: boolean; requiredBayType: string | null; name: string },
    catalogueRole: ServiceReadinessRow['catalogueRole'],
  ): string | null {
    if (s.isExternal) return 'External work, not performed by the Service Centre.';
    if (catalogueRole === 'PACKAGE_COMPONENT') {
      return 'A package sub-operation absorbed by a larger service — not a complete job a customer books on its own.';
    }
    if (s.requiredBayType === 'DIAGNOSTIC') {
      return 'Diagnostic work: the scope, and therefore the duration, is unknown until the vehicle is examined.';
    }
    if (/estimate/i.test(s.name)) {
      return 'An assessment carried out before the work is known — booking it as fixed-length work would misreserve the bay.';
    }
    return null;
  }

  /** The only relationship model that exists today is the KPI component role. */
  private catalogueRole(roles: string[]): ServiceReadinessRow['catalogueRole'] {
    if (roles.includes('INCLUDED_NO_ADDITIONAL_BENCHMARK')) return 'PACKAGE_COMPONENT';
    if (roles.includes('FORCES_CUSTOM_BENCHMARK')) return 'MAJOR_ADDITIONAL_WORK';
    if (roles.some((r) => r === 'GENERAL_SERVICE_CORE' || r === 'FRONT_BRAKES' || r === 'SPARK_PLUGS')) return 'PACKAGE_CORE';
    return 'STANDALONE';
  }

  private emptyEvidence(): DurationEvidence[] {
    return (['LIVE_PLATFORM', 'HISTORICAL_IMPORT'] as const).map((source) => ({
      source, sampleCount: 0, medianMinutes: null, p75Minutes: null, p90Minutes: null, from: null, to: null, insufficient: true,
    }));
  }

  /**
   * Per-service timing, split by origin and NEVER merged.
   *
   * A sample under 10 is marked insufficient rather than quietly shown as a
   * median: one job is an anecdote, and a page that prints it next to the word
   * "median" invites it to be treated as a measurement.
   */
  private async durationEvidence(): Promise<Map<string, DurationEvidence[]>> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ code: string; source_type: string; n: number; median: number | null; p75: number | null; p90: number | null; from_at: Date | null; to_at: Date | null }>
    >(`
      SELECT st.code,
             sv.source_type,
             count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (so.completed_at-so.started_at))/60) AS median,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (so.completed_at-so.started_at))/60) AS p75,
             percentile_cont(0.90) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (so.completed_at-so.started_at))/60) AS p90,
             min(so.started_at) AS from_at,
             max(so.started_at) AS to_at
      FROM service_orders so
      JOIN service_visits sv ON sv.id = so.service_visit_id
      JOIN service_order_items soi ON soi.service_order_id = so.id
      JOIN service_types st ON st.id = soi.service_type_id
      WHERE so.started_at IS NOT NULL AND so.completed_at IS NOT NULL
        AND so.completed_at > so.started_at
        AND EXTRACT(EPOCH FROM (so.completed_at-so.started_at))/60 BETWEEN 5 AND 600
      GROUP BY 1, 2
    `);

    const out = new Map<string, DurationEvidence[]>();
    for (const code of new Set(rows.map((r) => r.code))) out.set(code, this.emptyEvidence());
    for (const r of rows) {
      const source: DurationEvidence['source'] = r.source_type === 'HISTORICAL_IMPORT' ? 'HISTORICAL_IMPORT' : 'LIVE_PLATFORM';
      const list = out.get(r.code)!;
      const slot = list.find((e) => e.source === source)!;
      slot.sampleCount += r.n;
      slot.medianMinutes = r.median === null ? slot.medianMinutes : Math.round(r.median);
      slot.p75Minutes = r.p75 === null ? slot.p75Minutes : Math.round(r.p75);
      slot.p90Minutes = r.p90 === null ? slot.p90Minutes : Math.round(r.p90);
      slot.from = r.from_at ? r.from_at.toISOString().slice(0, 10) : slot.from;
      slot.to = r.to_at ? r.to_at.toISOString().slice(0, 10) : slot.to;
      slot.insufficient = slot.sampleCount < 10;
    }
    return out;
  }

  /**
   * Why per-service evidence is thin — stated once, at the top of the report, so
   * nobody reads an empty column as "this service is quick".
   */
  private async importEvidenceTotals(): Promise<CatalogueReadinessReport['evidenceSummary']> {
    const [row] = await this.prisma.$queryRawUnsafe<Array<{ live: number; imported: number; imported_linked: number }>>(`
      SELECT
        count(DISTINCT so.id) FILTER (WHERE sv.source_type <> 'HISTORICAL_IMPORT')::int AS live,
        count(DISTINCT so.id) FILTER (WHERE sv.source_type = 'HISTORICAL_IMPORT')::int AS imported,
        count(DISTINCT so.id) FILTER (WHERE sv.source_type = 'HISTORICAL_IMPORT' AND soi.service_type_id IS NOT NULL)::int AS imported_linked
      FROM service_orders so
      JOIN service_visits sv ON sv.id = so.service_visit_id
      LEFT JOIN service_order_items soi ON soi.service_order_id = so.id
    `);
    const linked = row?.imported_linked ?? 0;
    return {
      livePlatformOrders: row?.live ?? 0,
      historicalImportOrders: row?.imported ?? 0,
      historicalImportLinkedToServices: linked,
      note:
        linked === 0
          ? `None of the ${row?.imported ?? 0} imported job records carry service-type lines, so there is NO per-service historical duration evidence at all. ` +
            `Per-service timing can only come from work done on this platform (${row?.live ?? 0} orders so far), which is far too small to set durations from. ` +
            'Catalogue durations must be reviewed by people who know the work, not derived from this data.'
          : `${linked} of ${row?.imported ?? 0} imported job records carry service-type lines. Imported timing describes the legacy job sheet, not this platform, and is shown separately for that reason.`,
    };
  }

  /** A suggestion only — nothing is written. */
  private proposeName(internal: string): string | null {
    const cleaned = internal
      .replace(/\s*\/\s*/g, ' or ')
      .replace(/\b(PKG|INT|EXT|STD|ASM)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return cleaned && cleaned !== internal ? cleaned : null;
  }
}
