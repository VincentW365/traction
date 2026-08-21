/**
 * CR-2026-092 — fail the build when a service can be booked but not benchmarked.
 *
 * The problem this guards against is not hypothetical: four services sat unmapped for
 * three change requests, and every job carrying one of them came out unrated. A
 * service that is active for new bookings and has no contribution policy will do the
 * same thing again the next time somebody adds one to the catalogue.
 *
 * Exits non-zero on any failure so CI and `pnpm verify:kpi` both catch it.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** The four the directive named explicitly. Checked by name so they can never regress. */
const REQUIRED_CODES = ['FUEL-FLT-01', 'BRK-01', 'EST-01', 'TIR-01'];

const problems = [];
const now = new Date();

const services = await prisma.serviceType.findMany({
  select: { id: true, code: true, name: true, isActive: true, baseDurationMinutes: true },
  orderBy: { code: 'asc' },
});

const policies = await prisma.kpiServiceComponent.findMany({
  where: {
    isActive: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  },
});

const byService = new Map();
for (const p of policies) {
  if (!byService.has(p.serviceTypeId)) byService.set(p.serviceTypeId, p);
}

console.log('KPI contribution policy check\n');

for (const code of REQUIRED_CODES) {
  const svc = services.find((s) => s.code === code);
  if (!svc) {
    problems.push(`${code}: service not found in the catalogue`);
    continue;
  }
  const policy = byService.get(svc.id);
  if (!policy) {
    problems.push(`${code}: no active KPI contribution policy`);
    continue;
  }
  console.log(
    `  ${code.padEnd(12)} ${policy.contributionMode.padEnd(20)} ${policy.durationSource.padEnd(26)} ` +
      `qualifier=${policy.requiredQualifier}${policy.provisionalDuration ? '  [PROVISIONAL]' : ''}`,
  );
}

// Every ACTIVE service must be configured. Inactive ones are not bookable, so a gap
// there costs nothing until somebody reactivates them — which this same check catches.
const activeWithoutPolicy = services.filter((s) => s.isActive && !byService.get(s.id));
if (activeWithoutPolicy.length > 0) {
  problems.push(
    `${activeWithoutPolicy.length} active service(s) have no contribution policy: ` +
      activeWithoutPolicy.map((s) => s.code).join(', '),
  );
}

// A policy that draws its minutes from the catalogue, whose catalogue duration is
// missing, contributes zero and silently understates the standard.
for (const s of services) {
  const p = byService.get(s.id);
  if (!p) continue;
  if (
    p.durationSource === 'SERVICE_CATALOG_DURATION' &&
    (s.baseDurationMinutes == null || s.baseDurationMinutes <= 0)
  ) {
    problems.push(
      `${s.code}: takes its duration from the catalogue but has no usable catalogue duration`,
    );
  }
  if (p.contributionMode === 'CONDITIONAL' && p.requiredQualifier === 'NONE') {
    problems.push(`${s.code}: conditional but names no required qualifier`);
  }
  if (
    p.durationSource === 'FIXED_CONFIGURED_DURATION' &&
    (p.fixedSedanMinutes == null || p.fixedSedanMinutes <= 0)
  ) {
    problems.push(`${s.code}: fixed duration source with no configured minutes`);
  }
}

const provisional = policies.filter((p) => p.provisionalDuration);
const modes = policies.reduce((acc, p) => {
  acc[p.contributionMode] = (acc[p.contributionMode] ?? 0) + 1;
  return acc;
}, {});

console.log('\nActive policies by mode:');
for (const [mode, n] of Object.entries(modes).sort()) console.log(`  ${mode.padEnd(20)} ${n}`);
console.log(`\n  active services: ${services.filter((s) => s.isActive).length}`);
console.log(`  active policies: ${policies.length}`);
console.log(`  provisional durations awaiting management confirmation: ${provisional.length}`);

await prisma.$disconnect();

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nOK — every active service has a complete KPI contribution policy.');
