/**
 * Seed DEVTEST users for the dev-login role switcher (CR-2026-022, D-b).
 *
 *   (default)   DRY-RUN — report which DEVTEST users exist / would be created. NO writes.
 *   --commit    [GATED] Upsert the non-admin DEVTEST users (idempotent).
 *               Requires ALLOW_DEV_LOGIN=true AND NODE_ENV!=production.
 *
 * ADMIN is NEVER created here — it reuses the existing admin account.
 * DEVTEST users have passwordHash = NULL (reachable only via the gated dev-login
 * endpoint, never the normal login form). Clearly-marked emails; no secrets.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { DEV_LOGIN_PROFILES } from '../src/modules/auth/dev-login-profiles';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const DEFAULT_SITE_CODE = process.env.DEFAULT_SITE_CODE || 'BERT-01';

function devToolsEnabled(): boolean {
  return process.env.ALLOW_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production';
}

const prisma = new PrismaClient();

async function resolveAdmin() {
  return (
    (await prisma.userAccount.findFirst({ where: { email: 'admin@bert.local', roleCode: 'ADMIN', status: 'ACTIVE' } })) ??
    (await prisma.userAccount.findFirst({ where: { roleCode: 'ADMIN', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }))
  );
}

(async () => {
  const nonAdmin = DEV_LOGIN_PROFILES.filter((p) => !p.reuseExistingAdmin);
  const site =
    (await prisma.site.findUnique({ where: { code: DEFAULT_SITE_CODE } })) ??
    (await prisma.site.findFirst({ where: { isActive: true } }));
  if (!site) throw new Error('No Site found — cannot seed dev users.');
  const admin = await resolveAdmin();

  if (!COMMIT) {
    console.log('SEED DEV USERS — DRY RUN (no DB writes)');
    console.log(`  gate: ALLOW_DEV_LOGIN=${process.env.ALLOW_DEV_LOGIN ?? '(unset)'} NODE_ENV=${process.env.NODE_ENV ?? '(unset)'} -> ${devToolsEnabled() ? 'ENABLED' : 'DISABLED (commit will refuse)'}`);
    console.log(`  site: ${site.code}`);
    console.log(`  ADMIN (reused, not created): ${admin ? `${admin.email} / ${admin.id}` : 'NOT FOUND'}`);
    console.log('  DEVTEST users (passwordHash = null):');
    for (const p of nonAdmin) {
      const existing = await prisma.userAccount.findFirst({ where: { authSubject: p.email } });
      console.log(`    ${p.role.padEnd(22)} ${p.email.padEnd(32)} ${existing ? `exists (${existing.id})` : 'WOULD CREATE'}`);
    }
    console.log('  No rows written (dry run). Re-run with --commit (gate must be ENABLED).');
    await prisma.$disconnect();
    return;
  }

  if (!devToolsEnabled()) {
    throw new Error('Refusing --commit: requires ALLOW_DEV_LOGIN=true and NODE_ENV!=production.');
  }

  const mapping: Array<{ role: string; id: string; email: string | null; source: string }> = [];
  if (admin) mapping.push({ role: 'ADMIN', id: admin.id, email: admin.email, source: 'reused-existing' });
  for (const p of nonAdmin) {
    const user = await prisma.userAccount.upsert({
      where: { authSubject: p.email },
      update: { fullName: p.displayName, roleCode: p.role, status: 'ACTIVE' }, // idempotent; never sets a password
      create: {
        authSubject: p.email,
        email: p.email,
        fullName: p.displayName,
        roleCode: p.role,
        passwordHash: null,
        status: 'ACTIVE',
        siteId: site.id,
      },
    });
    mapping.push({ role: p.role, id: user.id, email: user.email, source: 'devtest' });
  }

  console.log('SEED DEV USERS — COMMITTED');
  console.log(JSON.stringify({ site: site.code, mapping }, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`ERROR: ${e?.message ?? e}`);
  await prisma.$disconnect();
  process.exit(1);
});
