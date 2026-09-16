/**
 * CR-2026-034 (C-1) / CR-2026-059 / CR-2026-107 — the seed's view of the required
 * operational forms.
 *
 * This file no longer DEFINES anything. The canonical template definitions and the
 * idempotent bootstrap now live in the application itself:
 *
 *     apps/api/src/modules/inspections/templates/required-forms.ts
 *
 * because that is the code the manager actually deploys. The seed, the API startup
 * bootstrap, /health, `pnpm forms:ensure` and `deploy:check` therefore all read ONE
 * definition, and a template can never be reproducible in the seed but missing from
 * the running application (CR-2026-107 root cause).
 *
 * Kept as a thin delegate so `prisma/seed.ts` and
 * `apps/api/scripts/seed-inspection-template.ts` keep their existing imports.
 */
import type { PrismaClient } from '@prisma/client';
import {
  CATEGORIES,
  TEMPLATE_NAME,
  TEMPLATE_VERSION,
  canonicalItems,
  ensureRequiredForms,
  requiredFormsState,
  type RequiredFormsState,
} from '../apps/api/src/modules/inspections/templates/required-forms';

export {
  CATEGORIES,
  TEMPLATE_NAME,
  TEMPLATE_VERSION,
  ensureRequiredForms,
  requiredFormsState,
  type RequiredFormsState,
};

/**
 * Seed the required inspection templates. Idempotent and safe to re-run: it
 * delegates to the same `ensureRequiredForms` the API runs at start, so "seeded"
 * and "works at runtime" cannot drift apart.
 */
export async function seedInspectionTemplate(prisma: PrismaClient): Promise<{
  templateId: string;
  version: number;
  isActive: boolean;
  itemCount: number;
  categories: number;
  forms: RequiredFormsState;
}> {
  // Throws unless both forms are usable afterwards, verified with the runtime
  // predicate rather than with the rows it just wrote.
  const { actions, forms } = await ensureRequiredForms(prisma).then((r) => ({ actions: r.actions, forms: r.state }));

  for (const a of actions) {
    console.warn(`Required forms — ${a.form}: ${a.action} — ${a.detail}`);
  }

  const template = await prisma.inspectionTemplate.findUniqueOrThrow({
    where: { kind_version: { kind: 'VEHICLE_INSPECTION', version: TEMPLATE_VERSION } },
    select: { id: true, version: true, isActive: true },
  });

  return {
    templateId: template.id,
    version: template.version,
    isActive: template.isActive,
    itemCount: canonicalItems().length,
    categories: CATEGORIES.length,
    forms,
  };
}
