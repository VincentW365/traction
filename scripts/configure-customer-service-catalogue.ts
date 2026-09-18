/**
 * CR-2026-111 / 111b — the customer-facing catalogue, and its activation gate.
 *
 *   pnpm booking:customer-catalogue                     # report only (default)
 *   pnpm booking:customer-catalogue --commit            # create/correct definitions
 *   pnpm booking:customer-catalogue --commit --activate # also offer them online
 *   pnpm booking:customer-catalogue --commit --withdraw # take unsafe ones back out
 *
 * §9 — this script is the ONLY way these services reach a customer. It is never
 * part of an ordinary deployment seed, because "what the shop offers the public"
 * is an operational decision, not a consequence of shipping code. Every run:
 *
 *   1. names the database it is pointed at;
 *   2. shows the current public catalogue;
 *   3. shows what it proposes to change;
 *   4. runs a preflight;
 *   5. is idempotent — a correct catalogue is left alone;
 *   6. writes only under --commit, and publishes only under --activate;
 *   7. reports the resulting customer-facing catalogue.
 *
 * The preflight's most important check is the one added by CR-2026-111b §2: a
 * service must not be offered to the public if production would plan it SHORTER
 * than its approved duration. General Servicing is 90/120; under the flat 80-minute
 * DEFAULT policy it would be under-planned for both vehicle classes, and every such
 * booking would run into the next customer's slot.
 */
import { PrismaClient } from '@prisma/client';
import {
  resolveAppointmentDuration,
  type DurationPolicy,
  type MeasurableService,
  type VehicleClass,
} from '../apps/api/src/modules/scheduling/availability/service-duration';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const ACTIVATE = process.argv.includes('--activate');
const WITHDRAW = process.argv.includes('--withdraw');
const out = (m: string) => console.log(`  ${m}`);
const rule = () => console.log('  ' + '-'.repeat(84));
const head = (t: string) => { console.log(`\n  ${t}`); rule(); };

/**
 * GEN-SERV-01 — General Servicing.
 *
 * 90 sedan / 120 SUV comes from `kpi_benchmarks`, which management approved for
 * GENERAL_SERVICE_ONLY.
 *
 * CR-2026-111b §5 — `baseDurationMinutes` is 90, but an unclassified vehicle no
 * longer resolves to it: the shared resolver takes the LONGEST configured figure
 * when the class is unknown. Over-planning costs a little capacity; under-planning
 * holds a bay past the slot and into the next customer's appointment.
 */
const GEN_SERV = {
  code: 'GEN-SERV-01',
  name: 'General Servicing',
  customerFacingName: 'General Servicing',
  family: 'Service',
  baseDurationMinutes: 90,
  sedanDurationMinutes: 90,
  suvDurationMinutes: 120,
  requiredBayType: 'GENERAL',
  requiresMileage: true,
  quickService: false,
  bookingBufferMinutes: 0,
};

/**
 * ASSESS-01 — Service Assessment, behind "Other / Describe My Issue".
 *
 * A controlled 30-minute slot for a customer who does not know what is wrong. It
 * exists because the alternative — reusing EST-01 — would classify every such job
 * as a General Service for KPI, and measure a 30-minute assessment against a
 * 90-minute standard. EST-01 is left exactly as it is.
 *
 * §8 — 30 minutes is the truthful catalogue value and stays 30, even while
 * production temporarily plans every booking at a different flat figure.
 */
const ASSESS = {
  code: 'ASSESS-01',
  name: 'Service Assessment',
  customerFacingName: 'Service Assessment',
  family: 'Service',
  baseDurationMinutes: 30,
  requiredBayType: 'GENERAL',
  requiresMileage: false,
  quickService: false,
  bookingBufferMinutes: 0,
};

/** The services this CR proposes to offer online. BAT-01 already exists. */
const PROPOSED_ONLINE = ['GEN-SERV-01', 'ASSESS-01', 'BAT-01'];

const SERVICE_SELECT = {
  id: true,
  code: true,
  name: true,
  customerFacingName: true,
  baseDurationMinutes: true,
  sedanDurationMinutes: true,
  suvDurationMinutes: true,
  requiredBayType: true,
  bookableOnline: true,
  isActive: true,
} as const;
type ServiceRow = {
  id: string; code: string; name: string; customerFacingName: string | null;
  baseDurationMinutes: number | null; sedanDurationMinutes: number | null; suvDurationMinutes: number | null;
  requiredBayType: string | null; bookableOnline: boolean; isActive: boolean;
};

// ---------------------------------------------------------------------------
// §9.1 — which database is this?
// ---------------------------------------------------------------------------

/** Host and database name from DATABASE_URL, with credentials stripped. */
function describeTarget(): { label: string; looksLocal: boolean } {
  const raw = process.env.DATABASE_URL ?? '';
  try {
    const u = new URL(raw);
    const host = u.hostname || '(unknown host)';
    const db = u.pathname.replace(/^\//, '') || '(unknown database)';
    const looksLocal = ['localhost', '127.0.0.1', '::1'].includes(host);
    return { label: `${db} on ${host}${u.port ? `:${u.port}` : ''}`, looksLocal };
  } catch {
    return { label: '(DATABASE_URL is not set or is unparseable)', looksLocal: false };
  }
}

/** The production duration policy in force, and the flat figure it plans with. */
async function loadPolicy(siteId: string): Promise<{ policy: DurationPolicy; defaultMinutes: number }> {
  const row = await prisma.businessRuleConfig.findFirst({
    where: { ruleKey: 'appointment_duration_source', effectiveTo: null, OR: [{ siteId }, { siteId: null }] },
    orderBy: { siteId: 'desc' }, // a site-specific row wins over the global one
    select: { valueJson: true },
  });
  const value = typeof row?.valueJson === 'string' ? row.valueJson : String(row?.valueJson ?? 'DEFAULT');
  const defaultRow = await prisma.businessRuleConfig.findFirst({
    where: { ruleKey: 'booking_default_duration_minutes', effectiveTo: null, OR: [{ siteId }, { siteId: null }] },
    orderBy: { siteId: 'desc' },
    select: { valueJson: true },
  });
  const parsed = Number(defaultRow?.valueJson ?? 80);
  return {
    policy: value === 'CATALOGUE' ? 'CATALOGUE' : 'DEFAULT',
    defaultMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : 80,
  };
}

// ---------------------------------------------------------------------------
// §9.4 — preflight
// ---------------------------------------------------------------------------

interface Preflight {
  blockers: string[];
  warnings: string[];
  /** The worst shortfall across vehicle classes, in minutes. */
  shortfall: number;
}

/**
 * Is this service safe to offer to the public right now?
 *
 * The readiness checks (§15) are unchanged. The new one is §2: compare the
 * duration production would actually PLAN against what the service is configured
 * to take, for every vehicle class it distinguishes. A shortfall is a blocker,
 * because the slot sold to the customer would be shorter than the work.
 *
 * Over-planning is only a warning. It wastes a little capacity, which is a
 * throughput question, not a safety one.
 */
function preflight(s: ServiceRow, policy: DurationPolicy, defaultMinutes: number): Preflight {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!s.isActive) blockers.push('service is not active');
  if (!s.requiredBayType) blockers.push('no required capability — nothing would know where it can run');
  if (!s.baseDurationMinutes || s.baseDurationMinutes < 5) blockers.push('no usable duration');
  if (!(s.customerFacingName ?? s.name).trim()) blockers.push('no customer-facing name');

  const measurable: MeasurableService = {
    code: s.code,
    baseDurationMinutes: s.baseDurationMinutes,
    sedanDurationMinutes: s.sedanDurationMinutes,
    suvDurationMinutes: s.suvDurationMinutes,
  };

  let shortfall = 0;
  for (const vehicleClass of ['SEDAN_CLASS', 'SUV_CLASS', null] as VehicleClass[]) {
    const r = resolveAppointmentDuration({ services: [measurable], vehicleClass, policy, defaultMinutes });
    if (r.underPlannedByMinutes > shortfall) shortfall = r.underPlannedByMinutes;
    if (r.underPlannedByMinutes > 0) {
      const who = vehicleClass ? vehicleClass.replace('_CLASS', '').toLowerCase() : 'unclassified';
      blockers.push(
        `would be UNDER-PLANNED for a ${who} vehicle: production plans ${r.plannedMinutes} minutes, ` +
          `the approved duration is ${r.catalogueMinutes} (${r.underPlannedByMinutes} short)`,
      );
    } else if (r.catalogueMinutes > 0 && r.plannedMinutes > r.catalogueMinutes && vehicleClass === null) {
      warnings.push(`production plans ${r.plannedMinutes} minutes for ${r.catalogueMinutes} minutes of work — capacity is spent, nothing is at risk`);
    }
  }

  return { blockers, warnings: [...new Set(warnings)], shortfall };
}

/** What production would plan for this service, per class, as a printable string. */
function plannedFor(s: ServiceRow, policy: DurationPolicy, defaultMinutes: number): string {
  const measurable: MeasurableService = {
    code: s.code,
    baseDurationMinutes: s.baseDurationMinutes,
    sedanDurationMinutes: s.sedanDurationMinutes,
    suvDurationMinutes: s.suvDurationMinutes,
  };
  const forClass = (c: VehicleClass) => resolveAppointmentDuration({ services: [measurable], vehicleClass: c, policy, defaultMinutes }).plannedMinutes;
  const sedan = forClass('SEDAN_CLASS');
  const suv = forClass('SUV_CLASS');
  return sedan === suv ? `${sedan}` : `${sedan} / ${suv}`;
}

/** The configured duration, per class, as a printable string. */
function catalogueFor(s: ServiceRow): string {
  if (!s.sedanDurationMinutes && !s.suvDurationMinutes) return `${s.baseDurationMinutes ?? '-'}`;
  return `${s.sedanDurationMinutes ?? s.baseDurationMinutes} / ${s.suvDurationMinutes ?? s.baseDurationMinutes}`;
}

// ---------------------------------------------------------------------------

async function main() {
  const site = await prisma.site.findFirstOrThrow({ select: { id: true, name: true } });
  const target = describeTarget();
  const { policy, defaultMinutes } = await loadPolicy(site.id);

  console.log(`\nCR-2026-111 — customer service catalogue`);
  rule();
  out(`Site       : ${site.name}`);
  out(`Database   : ${target.label}`);
  if (!target.looksLocal) {
    out('             \x1b[33m^ this is NOT a local database. Read the proposal before committing.\x1b[0m');
  }
  out(`Duration   : policy ${policy}${policy === 'DEFAULT' ? ` — every booking is planned at a flat ${defaultMinutes} minutes` : ' — each service at its own configured duration'}`);
  out(`Mode       : ${COMMIT ? `COMMIT${ACTIVATE ? ' + ACTIVATE' : ''}${WITHDRAW ? ' + WITHDRAW' : ''}` : 'REPORT ONLY (pass --commit to apply)'}`);

  // --- §9.2 the catalogue as it stands now ---------------------------------
  const before = (await prisma.serviceType.findMany({
    where: { bookableOnline: true, isActive: true },
    select: SERVICE_SELECT,
    orderBy: { code: 'asc' },
  })) as ServiceRow[];

  head(`Public catalogue now — ${before.length} service(s)`);
  if (before.length === 0) out('(nothing is offered online)');
  for (const s of before) {
    const pf = preflight(s, policy, defaultMinutes);
    const flag = pf.blockers.length ? '\x1b[31m  ← UNSAFE\x1b[0m' : '';
    out(`${s.code.padEnd(13)} ${(s.customerFacingName ?? s.name).padEnd(34)} catalogue ${catalogueFor(s).padStart(9)}  planned ${plannedFor(s, policy, defaultMinutes).padStart(9)}${flag}`);
    for (const b of pf.blockers) out(`${''.padEnd(13)} \x1b[31m• ${b}\x1b[0m`);
  }

  // --- definitions ---------------------------------------------------------
  head('Service definitions');
  for (const def of [GEN_SERV, ASSESS]) {
    const existing = (await prisma.serviceType.findUnique({ where: { code: def.code }, select: SERVICE_SELECT })) as ServiceRow | null;
    if (existing) {
      const drift: string[] = [];
      if (existing.baseDurationMinutes !== def.baseDurationMinutes) drift.push(`base ${existing.baseDurationMinutes}→${def.baseDurationMinutes}`);
      if ((existing.sedanDurationMinutes ?? null) !== ((def as { sedanDurationMinutes?: number }).sedanDurationMinutes ?? null)) drift.push('sedan minutes');
      if ((existing.suvDurationMinutes ?? null) !== ((def as { suvDurationMinutes?: number }).suvDurationMinutes ?? null)) drift.push('suv minutes');
      out(`${def.code.padEnd(13)} exists${drift.length ? ` — would correct: ${drift.join(', ')}` : ' and is correct'}`);
      if (COMMIT && drift.length) {
        await prisma.serviceType.update({ where: { id: existing.id }, data: def as never });
        out(`${''.padEnd(13)} corrected`);
      }
      continue;
    }
    if (!COMMIT) {
      out(`${def.code.padEnd(13)} would CREATE "${def.name}" — ${def.baseDurationMinutes}m, ${def.requiredBayType}, NOT bookable online`);
      continue;
    }
    await prisma.serviceType.create({ data: { ...def, bookableOnline: false, isActive: true } as never });
    out(`${def.code.padEnd(13)} CREATED "${def.name}" — ${def.baseDurationMinutes}m, ${def.requiredBayType}, NOT bookable online`);
  }

  // --- KPI mappings --------------------------------------------------------
  head('KPI classification');
  for (const [code, role, mode] of [
    ['GEN-SERV-01', 'GENERAL_SERVICE_CORE', 'PACKAGE_COMPONENT'],
    // The whole reason ASSESS-01 exists rather than reusing EST-01.
    ['ASSESS-01', 'INCLUDED_NO_ADDITIONAL_BENCHMARK', 'SEPARATE_SLA'],
  ] as const) {
    const svc = await prisma.serviceType.findUnique({ where: { code }, select: { id: true } });
    if (!svc) { out(`${code.padEnd(13)} not created yet (report only)`); continue; }
    const existing = await prisma.kpiServiceComponent.findFirst({
      where: { serviceTypeId: svc.id, isActive: true },
      select: { componentRole: true, contributionMode: true },
    });
    if (existing) { out(`${code.padEnd(13)} already mapped: ${existing.componentRole} / ${existing.contributionMode}`); continue; }
    if (!COMMIT) { out(`${code.padEnd(13)} would map ${role} / ${mode}`); continue; }
    await prisma.kpiServiceComponent.create({
      data: {
        serviceTypeId: svc.id,
        componentRole: role as never,
        contributionMode: mode as never,
        durationSource: 'NO_DURATION' as never,
        notes: 'CR-2026-111 — customer-facing booking category mapping.',
      },
    });
    out(`${code.padEnd(13)} mapped ${role} / ${mode}`);
  }

  // --- §9.3/§9.4 the proposal, and the gate --------------------------------
  head('Online availability — preflight');
  let blocked = 0;
  for (const code of PROPOSED_ONLINE) {
    const s = (await prisma.serviceType.findUnique({ where: { code }, select: SERVICE_SELECT })) as ServiceRow | null;
    if (!s) { out(`${code.padEnd(13)} not found`); continue; }

    const pf = preflight(s, policy, defaultMinutes);

    if (pf.blockers.length) {
      blocked++;
      out(`${code.padEnd(13)} \x1b[31mBLOCKED\x1b[0m — must not be offered to the public`);
      for (const b of pf.blockers) out(`${''.padEnd(13)} • ${b}`);
      // §2 — if it is ALREADY public and unsafe, it has to come back out.
      if (s.bookableOnline) {
        if (COMMIT && WITHDRAW) {
          await prisma.serviceType.update({ where: { id: s.id }, data: { bookableOnline: false } });
          out(`${''.padEnd(13)} \x1b[33mWITHDRAWN from the public catalogue\x1b[0m`);
        } else {
          out(`${''.padEnd(13)} \x1b[33mit is CURRENTLY PUBLIC — re-run with --commit --withdraw to take it out\x1b[0m`);
        }
      }
      continue;
    }

    for (const w of pf.warnings) out(`${code.padEnd(13)} note: ${w}`);
    if (s.bookableOnline) { out(`${code.padEnd(13)} already offered online`); continue; }
    if (!ACTIVATE) { out(`${code.padEnd(13)} validated, ready — pass --activate to offer it online`); continue; }
    if (!COMMIT) { out(`${code.padEnd(13)} would be offered online`); continue; }
    await prisma.serviceType.update({ where: { id: s.id }, data: { bookableOnline: true } });
    out(`${code.padEnd(13)} \x1b[32mNOW OFFERED ONLINE\x1b[0m`);
  }

  // --- §9.7 the resulting customer-facing catalogue ------------------------
  const after = (await prisma.serviceType.findMany({
    where: { bookableOnline: true, isActive: true },
    select: SERVICE_SELECT,
    orderBy: { code: 'asc' },
  })) as ServiceRow[];

  head(`Customer-facing catalogue ${COMMIT ? 'now' : 'if committed'} — ${after.length} service(s)`);
  out(`${'CODE'.padEnd(13)} ${'CUSTOMER SEES'.padEnd(34)} ${'CATALOGUE'.padStart(9)}  ${'PLANNED'.padStart(9)}  CAPABILITY`);
  for (const s of after) {
    out(
      `${s.code.padEnd(13)} ${(s.customerFacingName ?? s.name).padEnd(34)} ${catalogueFor(s).padStart(9)}  ${plannedFor(s, policy, defaultMinutes).padStart(9)}  ${s.requiredBayType ?? '-'}`,
    );
  }
  out('');
  out('CATALOGUE = the approved duration (sedan / SUV where they differ).');
  out(`PLANNED   = what production actually schedules today, under policy ${policy}.`);

  console.log('');
  if (blocked > 0) {
    console.log(`  \x1b[31m${blocked} service(s) cannot be offered to the public under the current duration policy.\x1b[0m`);
    console.log('  Either switch appointment_duration_source to CATALOGUE, or leave them non-public.\n');
    process.exitCode = 1;
  } else if (!COMMIT) {
    console.log('  Nothing was written. Re-run with --commit.\n');
  } else if (!ACTIVATE) {
    console.log('  Nothing was made public. Re-run with --commit --activate when validated.\n');
  } else {
    console.log('');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
