/**
 * CR-2026-113 §2 — what is actually in the customer email column.
 *
 *   pnpm customers:email-quality
 *
 * Run it before and after the placeholder-clearing migration
 * (`20260921150000_cr_2026_113_clear_placeholder_emails`) to verify the change
 * did exactly what it said: placeholders became NULL, the customer count did
 * not move, and no real address was touched.
 *
 * It is READ-ONLY. It changes nothing, so it is safe against production.
 *
 * It also names the rows a migration deliberately refused to guess at — an
 * address with a missing "@", free text in the email column — because those
 * need a person who knows the customer, not a regular expression.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLACEHOLDER_SQL = `lower(btrim(email)) IN ('n/a','na','n.a.','none','null','nil','-','--','.','')`;

async function count(where: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM customers WHERE ${where}`,
  );
  return rows[0]?.n ?? 0;
}

async function main(): Promise<void> {
  const customers = await count('TRUE');
  const noEmail = await count('email IS NULL');
  const placeholders = await count(`email IS NOT NULL AND ${PLACEHOLDER_SQL}`);
  const real = await count(`email IS NOT NULL AND position('@' in email) > 0`);
  const oddities = await prisma.$queryRawUnsafe<Array<{ email: string; customer_number: string }>>(
    `SELECT email, customer_number FROM customers
      WHERE email IS NOT NULL AND position('@' in email) = 0 AND NOT (${PLACEHOLDER_SQL})
      ORDER BY customer_number LIMIT 50`,
  );
  const optedIn = await count(`notification_opt_in_email = true`);
  const optedInWithAddress = await count(
    `notification_opt_in_email = true AND email IS NOT NULL AND position('@' in email) > 0`,
  );

  console.log('CUSTOMER EMAIL QUALITY');
  console.log('─'.repeat(64));
  console.log(`  customers                          ${String(customers).padStart(6)}`);
  console.log(`  no address recorded (NULL)         ${String(noEmail).padStart(6)}`);
  console.log(`  placeholder text still stored      ${String(placeholders).padStart(6)}  ${placeholders === 0 ? '(clean)' : '← run the migration'}`);
  console.log(`  real addresses                     ${String(real).padStart(6)}`);
  console.log('');
  console.log('  OPTIONAL-EMAIL CONSENT (marketing only — CR-2026-113 §1)');
  console.log(`  opted in                           ${String(optedIn).padStart(6)}`);
  console.log(`  opted in AND reachable             ${String(optedInWithAddress).padStart(6)}`);
  console.log('');
  console.log('  Operational email (confirmations, authorisation requests, ready for');
  console.log('  collection) is not gated on that preference: it needs an address only,');
  console.log(`  which ${real} customers now have.`);

  if (oddities.length) {
    console.log('');
    console.log(`  NEEDS A PERSON — ${oddities.length} value(s) that are neither a placeholder nor an address.`);
    console.log('  Not guessed at by any migration: repairing one would be inventing customer data.');
    for (const o of oddities) console.log(`    ${o.customer_number}  "${o.email}"`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
