/**
 * CR-2026-053 — create real (password) logins for live-like testing.
 *
 * Idempotent: upserts one user per role with a known email/password so the app can
 * be exercised through the normal login form (no dev-login / sandbox). Re-runnable
 * to reset the passwords. Dev-only convenience — do not run against production.
 *
 *   pnpm --filter @bsop/api exec tsx scripts/create-test-logins.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const SITE_CODE = process.env.DEFAULT_SITE_CODE || 'BERT-01';

const USERS = [
  { email: 'manager@test.com', password: 'manager123', fullName: 'Test Manager', roleCode: 'ADMIN' },
  { email: 'advisor@test.com', password: 'advisor123', fullName: 'Test Service Advisor', roleCode: 'SERVICE_ADVISOR' },
  { email: 'technician@test.com', password: 'technician123', fullName: 'Test Technician', roleCode: 'TECHNICIAN', employeeCode: 'TEST-TECH-01' },
];

(async () => {
  const site =
    (await prisma.site.findUnique({ where: { code: SITE_CODE } })) ??
    (await prisma.site.findFirst({ where: { isActive: true } }));
  if (!site) throw new Error('No Site found — cannot create test logins.');

  console.log(`Creating test logins (site ${site.code}):`);
  for (const u of USERS) {
    const passwordHash = bcrypt.hashSync(u.password, 10);
    const user = await prisma.userAccount.upsert({
      where: { authSubject: u.email },
      update: { email: u.email, fullName: u.fullName, roleCode: u.roleCode, passwordHash, status: 'ACTIVE', siteId: site.id },
      create: { authSubject: u.email, email: u.email, fullName: u.fullName, roleCode: u.roleCode, passwordHash, status: 'ACTIVE', siteId: site.id },
    });

    // A technician also needs a Technician record to appear in workshop flows.
    if (u.roleCode === 'TECHNICIAN' && u.employeeCode) {
      await prisma.technician.upsert({
        where: { userAccountId: user.id },
        update: { employeeCode: u.employeeCode, homeSiteId: site.id, status: 'ACTIVE' },
        create: { userAccountId: user.id, employeeCode: u.employeeCode, homeSiteId: site.id, status: 'ACTIVE' },
      });
    }
    console.log(`  ${u.roleCode.padEnd(16)} ${u.email}  /  ${u.password}`);
  }
  console.log('Done. Log in via the normal login form.');
})().catch((e) => { console.error(`ERROR: ${e?.message ?? e}`); process.exit(1); }).finally(() => prisma.$disconnect());
