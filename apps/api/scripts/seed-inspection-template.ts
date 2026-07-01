/**
 * CR-2026-034 (C-1) / CR-2026-059 — seed the v1 active Visual Inspection Form template.
 *
 * Standalone runner for an EXISTING database (the main `pnpm db:seed` now also seeds
 * this template for fresh databases). The template data + seeding logic live in the
 * shared, side-effect-free module prisma/inspection-template-data.ts (single source
 * of truth). Idempotent — safe to re-run.
 *
 *   pnpm --filter @bsop/api exec tsx scripts/seed-inspection-template.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedInspectionTemplate } from '../../../prisma/inspection-template-data';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await seedInspectionTemplate(prisma);
    console.log('SEED_OK ' + JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('SEED_ERR', e?.message ?? e);
  process.exit(1);
});
