/**
 * CR-2026-108 Stage 4C — apply management's approved self-service pilot catalogue.
 *
 *     pnpm booking:pilot-catalogue            # show what would change
 *     pnpm booking:pilot-catalogue --commit   # apply it
 *
 * WHY THIS IS A SCRIPT AND NOT THE SEED
 * `bookableOnline` is a management DECISION, not reference data. Seeding it would
 * resurrect this exact list every deploy and silently overrule a manager who later
 * enabled or withdrew a service — the same class of defect as CR-2026-095's
 * technician roster. So it is an explicit, auditable, idempotent action, kept in
 * git so the manager's deployment can apply the same decision rather than someone
 * retyping it from a document.
 *
 * It sets ONLY the six approved services. It does not disable anything else and it
 * does not touch enforcement or the duration source: those are separate decisions
 * (Stage 4D and 4F), and combining them is exactly how "which services?" and "how
 * much capacity do they consume?" get confused with one another.
 */
import { PrismaClient } from '@prisma/client';

/**
 * The approved pilot. Six routine, predictable services — deliberately fewer than
 * the sixteen the readiness audit judged suitable for CONSIDERATION, because
 * "ready for review" is not "ready for a first production pilot".
 *
 * Buffers are 0 on purpose: a turnover buffer must come from observed turnaround,
 * and there is no per-service evidence to derive one from yet (docs/122 §F3).
 */
const PILOT = [
  { code: 'OIL-01', customerFacingName: 'Oil Change', bookingBufferMinutes: 0 },
  { code: 'TIR-01', customerFacingName: 'Tire Rotation', bookingBufferMinutes: 0 },
  { code: 'BRK-01', customerFacingName: 'Brake Inspection', bookingBufferMinutes: 0 },
  { code: 'TIR-02', customerFacingName: 'Wheel Alignment', bookingBufferMinutes: 0 },
  // Clearer than "Pre-Purchase Inspection" on a customer-facing page.
  { code: 'INSP-01', customerFacingName: 'Pre-Purchase Vehicle Inspection', bookingBufferMinutes: 0 },
  { code: 'CLEAN-01', customerFacingName: 'Vehicle Cleaning', bookingBufferMinutes: 0 },
] as const;

const commit = process.argv.includes('--commit');
const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(`\nCR-2026-108 Stage 4C — pilot self-service catalogue (${commit ? 'COMMIT' : 'DRY RUN'})\n`);

  const actor = await prisma.userAccount.findFirst({ where: { roleCode: 'ADMIN' }, select: { id: true } });

  for (const want of PILOT) {
    const current = await prisma.serviceType.findUnique({
      where: { code: want.code },
      select: { id: true, name: true, isActive: true, isExternal: true, baseDurationMinutes: true, bookableOnline: true, customerFacingName: true, bookingBufferMinutes: true },
    });
    if (!current) {
      console.error(`  SKIP ${want.code} — not in the catalogue on this deployment.`);
      continue;
    }
    // Guard rails: refuse to expose something that could not be booked anyway.
    if (!current.isActive || current.isExternal) {
      console.error(`  REFUSE ${want.code} — ${!current.isActive ? 'inactive' : 'external'}; it cannot be a customer service.`);
      continue;
    }
    if (!current.baseDurationMinutes || current.baseDurationMinutes <= 0) {
      console.error(`  REFUSE ${want.code} — no catalogue duration; a slot could not be sized.`);
      continue;
    }

    const changes: string[] = [];
    if (!current.bookableOnline) changes.push('bookableOnline false -> true');
    if ((current.customerFacingName ?? null) !== want.customerFacingName) {
      changes.push(`customerFacingName ${current.customerFacingName ?? '(unset)'} -> "${want.customerFacingName}"`);
    }
    if (current.bookingBufferMinutes !== want.bookingBufferMinutes) {
      changes.push(`bookingBufferMinutes ${current.bookingBufferMinutes} -> ${want.bookingBufferMinutes}`);
    }

    if (changes.length === 0) {
      console.log(`  = ${want.code.padEnd(11)} already configured ("${want.customerFacingName}", ${current.baseDurationMinutes}m, buffer ${current.bookingBufferMinutes})`);
      continue;
    }
    console.log(`  ${commit ? '>' : '?'} ${want.code.padEnd(11)} ${changes.join('; ')}`);

    if (!commit) continue;
    await prisma.serviceType.update({
      where: { code: want.code },
      data: {
        bookableOnline: true,
        customerFacingName: want.customerFacingName,
        bookingBufferMinutes: want.bookingBufferMinutes,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: actor?.id ?? null,
        action: 'SERVICE_TYPE_UPDATE',
        entityType: 'ServiceType',
        entityId: current.id,
        beforeJson: {
          bookableOnline: current.bookableOnline,
          customerFacingName: current.customerFacingName,
          bookingBufferMinutes: current.bookingBufferMinutes,
        } as never,
        afterJson: {
          bookableOnline: true,
          customerFacingName: want.customerFacingName,
          bookingBufferMinutes: want.bookingBufferMinutes,
        } as never,
        reasonCode: 'SELF_SERVICE_PILOT_CATALOGUE',
        notes: 'CR-2026-108 Stage 4C — approved pilot self-service catalogue. Enforcement remains off until Stage 4D preflight is reviewed.',
      },
    });
  }

  // --- report the resulting state, including what did NOT change ---
  const [total, bookable, enforce, durationSource] = await Promise.all([
    prisma.serviceType.count({ where: { isActive: true } }),
    prisma.serviceType.findMany({ where: { bookableOnline: true }, select: { code: true, customerFacingName: true, baseDurationMinutes: true, bookingBufferMinutes: true }, orderBy: { code: 'asc' } }),
    prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'booking_enforce_online_bookable', effectiveTo: null }, select: { valueJson: true } }),
    prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'appointment_duration_source', effectiveTo: null }, select: { valueJson: true } }),
  ]);

  console.log('\n  --- resulting state ---');
  console.log(`  active services              : ${total}`);
  console.log(`  bookableOnline = true        : ${bookable.length}`);
  for (const b of bookable) {
    console.log(`     ${b.code.padEnd(11)} "${b.customerFacingName}"  ${b.baseDurationMinutes}m  buffer ${b.bookingBufferMinutes}`);
  }
  console.log(`  booking_enforce_online_bookable: ${JSON.stringify(enforce?.valueJson ?? null)}  (unchanged by this script)`);
  console.log(`  appointment_duration_source    : ${JSON.stringify(durationSource?.valueJson ?? null)}  (unchanged by this script)`);
  if (!commit) console.log('\n  DRY RUN — nothing was written. Re-run with --commit to apply.');
  console.log('');
}

main()
  .catch((e) => {
    console.error(`\nFAIL — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
