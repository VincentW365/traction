/**
 * CR-2026-113 §3 — say "Collection", not "Pickup", in the live ready-for-vehicle
 * email.
 *
 *   pnpm notifications:collection-wording           (report only)
 *   pnpm notifications:collection-wording --commit  (apply)
 *
 * WHY THIS IS A SCRIPT AND NOT A SEED CHANGE
 *   Seeding is create-if-missing on purpose: it is what stops a deployment from
 *   overwriting wording a manager chose. That rule is not being weakened here.
 *   This does what a manager does when they open Setup → Notifications and edit
 *   the template — same table, same version bump, same audit trail — so the
 *   change is attributable and reversible in exactly the same way.
 *
 * WHAT IT CHANGES
 *   The words "Pickup"/"pickup" → "Collection"/"collection", in the subject,
 *   body and name of the PICKUP_READY template. Nothing else in the wording is
 *   touched, so any other edit a manager has made survives untouched.
 *
 *   The stored reason code stays PICKUP_READY. Renaming a value that history
 *   already refers to would rewrite the past to change a label.
 *
 * IDEMPOTENT: a template that already says "Collection" is left alone and
 * reported as such, so this is safe to run on every environment, twice.
 */
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  pickupToCollection,
  placeholderDrift,
} from '../apps/api/src/modules/notifications/templates/wording-transform';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');

/**
 * CR-2026-114 §8 — the substitution now lives in a tested module that cannot
 * touch a {{placeholder}}. See templates/wording-transform.ts for why.
 */
const toCollection = pickupToCollection;

async function main(): Promise<void> {
  const rows = await prisma.notificationTemplate.findMany({
    where: { reason: 'PICKUP_READY', channel: 'EMAIL' },
    select: { id: true, key: true, name: true, subject: true, body: true, version: true, updatedByUserId: true },
  });

  if (rows.length === 0) {
    console.log('No PICKUP_READY email template found — nothing to change.');
    console.log('(The API self-heals one from factory wording, which already says "Collection".)');
    return;
  }

  let changed = 0;
  let wouldChange = 0;
  for (const row of rows) {
    const next = {
      name: toCollection(row.name),
      subject: row.subject ? toCollection(row.subject) : row.subject,
      body: toCollection(row.body),
    };
    const differs =
      next.name !== row.name || next.subject !== row.subject || next.body !== row.body;

    console.log(`\n${row.key} (v${row.version})${row.updatedByUserId ? ' — edited by a person' : ''}`);
    if (!differs) {
      console.log('  already says "Collection" — left alone');
      continue;
    }
    console.log(`  name:    ${row.name}\n        -> ${next.name}`);
    console.log(`  subject: ${row.subject}\n        -> ${next.subject}`);
    if (next.body !== row.body) {
      const before = row.body.split('\n').find((l) => /pickup/i.test(l));
      const after = next.body.split('\n').find((l) => /collection/i.test(l));
      console.log(`  body:    ${before?.trim()}\n        -> ${after?.trim()}`);
    }

    wouldChange++;
    if (!COMMIT) {
      console.log('  (dry run — pass --commit to apply)');
      continue;
    }

    // CR-2026-114 §8 — refuse to write a change that altered the template's
    // VOCABULARY. Renaming a placeholder is a migration, not a wording tweak.
    const drift = placeholderDrift(row.body + (row.subject ?? ''), next.body + (next.subject ?? ''));
    if (drift.added.length || drift.removed.length) {
      throw new Error(
        `Refusing to write ${row.key}: the transformation changed template variables (removed ${drift.removed.join(', ') || 'none'}, added ${drift.added.join(', ') || 'none'}). Placeholders are a registered vocabulary and are migrated deliberately, never as a side effect of wording.`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.notificationTemplate.update({
        where: { id: row.id },
        data: { ...next, version: { increment: 1 } },
      });
      // The same audit action a manager's edit writes, with a null actor: the
      // platform's convention for a system-initiated change (CR-2026-113 §3).
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'NOTIFICATION_TEMPLATE_UPDATED',
          entityType: 'NotificationTemplate',
          entityId: row.id,
          beforeJson: { name: row.name, subject: row.subject, body: row.body, version: row.version } as Prisma.InputJsonValue,
          afterJson: { ...next, version: row.version + 1 } as Prisma.InputJsonValue,
          reasonCode: 'TERMINOLOGY_ALIGNMENT',
          notes:
            'CR-2026-113 §3 — "Pickup" replaced with "Collection" so the email matches the wording used everywhere else in the Service Centre. No other wording was altered.',
        },
      });
    });
    changed++;
    console.log('  updated');
  }

  console.log(
    COMMIT
      ? `\n${changed} template(s) updated, ${rows.length - changed} already correct.`
      : `\n${wouldChange} template(s) would change, ${rows.length - wouldChange} already correct. Pass --commit to apply.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
