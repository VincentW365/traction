/**
 * CR-2026-111 — the two approved catalogue additions, plus Battery for online.
 *
 *   pnpm booking:customer-catalogue            # show what it would do
 *   pnpm booking:customer-catalogue --commit   # apply
 *   pnpm booking:customer-catalogue --activate # also set bookableOnline (see below)
 *
 * Creates GEN-SERV-01 and ASSESS-01 with `bookableOnline = false`, per §15: a new
 * service is validated before it is offered to a customer, never as a side effect
 * of existing. `--activate` is the separate, deliberate second step.
 *
 * Idempotent: everything is matched by code and skipped when already correct.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const ACTIVATE = process.argv.includes('--activate');
const out = (m: string) => console.log(`  ${m}`);

/**
 * GEN-SERV-01 — General Servicing.
 *
 * 90 sedan / 120 SUV comes from `kpi_benchmarks`, which management approved for
 * GENERAL_SERVICE_ONLY. `baseDurationMinutes` is the sedan figure so that a
 * vehicle of unknown class gets the SHORTER promise: under-promising a slot is
 * recoverable, over-promising one strands a vehicle in a bay somebody else needs.
 *
 * Its KPI role is GENERAL_SERVICE_CORE, which is what it genuinely is — the
 * classifier that identifies a General Service package. That is the one place the
 * existing classifier list is the right answer.
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
 * SEPARATE_SLA is the honest contribution mode: an assessment is advisor and
 * diagnostic time, not technician repair time, so the technician is neither
 * charged nor credited for it.
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

async function main() {
  const site = await prisma.site.findFirstOrThrow({ select: { name: true } });
  console.log(`\nCR-2026-111 — customer service catalogue (${site.name})`);
  console.log(COMMIT ? `  MODE: COMMIT${ACTIVATE ? ' + ACTIVATE' : ''}\n` : '  MODE: DRY RUN (pass --commit to apply)\n');

  // --- GEN-SERV-01 ---------------------------------------------------------
  console.log('  New services');
  console.log('  ' + '-'.repeat(74));
  for (const def of [GEN_SERV, ASSESS]) {
    const existing = await prisma.serviceType.findUnique({
      where: { code: def.code },
      select: { id: true, name: true, baseDurationMinutes: true, sedanDurationMinutes: true, suvDurationMinutes: true, bookableOnline: true, isActive: true },
    });
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
  console.log('\n  KPI classification');
  console.log('  ' + '-'.repeat(74));
  for (const [code, role, mode] of [
    ['GEN-SERV-01', 'GENERAL_SERVICE_CORE', 'PACKAGE_COMPONENT'],
    // The whole reason ASSESS-01 exists rather than reusing EST-01.
    ['ASSESS-01', 'INCLUDED_NO_ADDITIONAL_BENCHMARK', 'SEPARATE_SLA'],
  ] as const) {
    const svc = await prisma.serviceType.findUnique({ where: { code }, select: { id: true } });
    if (!svc) { out(`${code.padEnd(13)} not created yet (dry run)`); continue; }
    const existing = await prisma.kpiServiceComponent.findFirst({
      where: { serviceTypeId: svc.id, isActive: true },
      select: { id: true, componentRole: true, contributionMode: true },
    });
    if (existing) {
      out(`${code.padEnd(13)} already mapped: ${existing.componentRole} / ${existing.contributionMode}`);
      continue;
    }
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

  // --- online activation, deliberately separate ----------------------------
  console.log('\n  Online availability');
  console.log('  ' + '-'.repeat(74));
  const ONLINE = ['GEN-SERV-01', 'ASSESS-01', 'BAT-01'];
  for (const code of ONLINE) {
    const s = await prisma.serviceType.findUnique({
      where: { code },
      select: { id: true, name: true, customerFacingName: true, bookableOnline: true, baseDurationMinutes: true, requiredBayType: true, isActive: true },
    });
    if (!s) { out(`${code.padEnd(13)} not found`); continue; }
    if (s.bookableOnline) { out(`${code.padEnd(13)} already offered online`); continue; }

    // §15 — validate before offering. A service with no required capability, no
    // duration or no customer-facing name is not ready to meet a customer.
    const problems: string[] = [];
    if (!s.isActive) problems.push('not active');
    if (!s.requiredBayType) problems.push('no required capability');
    if (!s.baseDurationMinutes || s.baseDurationMinutes < 5) problems.push('no usable duration');
    if (!(s.customerFacingName ?? s.name).trim()) problems.push('no customer-facing name');
    if (problems.length) { out(`${code.padEnd(13)} NOT READY: ${problems.join('; ')}`); continue; }

    if (!ACTIVATE) {
      out(`${code.padEnd(13)} validated, ready — pass --activate to offer it online`);
      continue;
    }
    if (!COMMIT) { out(`${code.padEnd(13)} would be offered online`); continue; }
    await prisma.serviceType.update({ where: { id: s.id }, data: { bookableOnline: true } });
    out(`${code.padEnd(13)} NOW OFFERED ONLINE`);
  }

  const online = await prisma.serviceType.count({ where: { bookableOnline: true, isActive: true } });
  console.log(`\n  Publicly bookable services: ${online}`);
  if (!COMMIT) console.log('  Nothing was written. Re-run with --commit.\n');
  else if (!ACTIVATE) console.log('  Nothing was made public. Re-run with --commit --activate when validated.\n');
  else console.log('');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
