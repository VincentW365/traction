/**
 * CR-2026-034 (C-1) / CR-2026-059 — canonical v1 Visual Inspection Form template.
 *
 * Single source of truth for the active inspection template, shared by the main
 * seed (prisma/seed.ts) and the standalone script (apps/api/scripts/seed-inspection-
 * template.ts). Pure data + a seeding function with NO side-effect imports (the
 * Prisma client is passed in), so importing this module is safe anywhere.
 *
 * Source of truth for the checklist: docs/56_Visual_Inspection_Form.md (the 3-state
 * checklist lines). Idempotent: upserts InspectionTemplate version 1 (active) and
 * replaces its items (inspections SNAPSHOT lines into InspectionItem, so template
 * items are not FK-referenced — clear+recreate is safe and re-runnable).
 */
import type { PrismaClient } from '@prisma/client';

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_NAME = 'Visual Inspection Form v1';

export const CATEGORIES: Array<{ category: string; items: Array<{ label: string; allowsNa?: boolean }> }> = [
  {
    category: 'Interior / Exterior',
    items: [
      { label: 'Head Lights / Tail Lights / Turn Signals / Brake Lights / Hazard Warning Lights / Exterior Lamps / License Plate Lights' },
      { label: 'Windshield Washer Spray / Wiper Operation / Wiper Blades' },
      { label: 'Windshield Condition (inspect for cracks, chips, or pitting)' },
      { label: 'Mirrors / Glass' },
      { label: 'Emergency Brake Adjustment' },
      { label: 'Horn Operation' },
      { label: 'Fuel Tank Cap Gasket' },
      { label: 'Air Conditioning Filter (if equipped)', allowsNa: true },
      { label: 'Clutch Operation (if equipped)', allowsNa: true },
      { label: 'Back-up Lights Left / Right' },
      { label: 'Dash Warning Lights' },
      { label: 'Carpet / Upholstery / Floor Mats' },
    ],
  },
  {
    category: 'Battery',
    items: [
      { label: 'Battery Terminals / Cables / Mountings' },
      { label: 'Check Condition of Battery (storage capacity test)' },
    ],
  },
  {
    category: 'Under Vehicle',
    items: [
      { label: 'Shock Absorbers / Suspension / Struts' },
      { label: 'Steering Gear Box / Linkage and Boots / Ball Joints / Dust Covers' },
      { label: 'Muffler / Exhaust Pipes / Mountings / Catalytic Converter' },
      { label: 'Engine Oil and/or Fluid Leaks' },
      { label: 'Brake Lines / Hoses / Parking Brake Cable' },
      { label: 'Drive Shaft Boots / CV Boots / U-joints / Transmission Linkage (if equipped)', allowsNa: true },
      { label: 'Transmission / Differential / Transfer Case (check fluid level, condition, leaks)' },
      { label: 'Fuel Lines and Connections / Fuel Tank Band / Fuel Tank Vapor Vent System Hoses' },
      { label: 'Inspect Nuts and Bolts on Body Chassis' },
    ],
  },
  {
    category: 'Under Hood',
    items: [
      { label: 'Fluid Levels: Oil / Coolant / Battery / Power Steering / Brake / Washer / Automatic Transmission' },
      { label: 'Engine Air Filter' },
      { label: 'Drive Belts (condition and adjustment)' },
      { label: 'Cooling System Hoses / Heater Hoses / A/C Hoses and Connections' },
      { label: 'Radiator Core / A/C Condenser (if equipped)', allowsNa: true },
      { label: 'Coolant Recovery Reservoir Fluid Level / Condition' },
      { label: 'Clutch Reservoir Fluid / Condition (as equipped)', allowsNa: true },
    ],
  },
];

/**
 * Upsert the active v1 template and (re)create its items. Idempotent and safe to
 * run repeatedly. Pass any PrismaClient (the caller owns its lifecycle).
 */
export interface RequiredFormsState {
  /** An active VEHICLE_INSPECTION template whose HIGHEST active version has ≥ 1 item. */
  serviceInspection: boolean;
  /** An active PRE_INSPECTION template (itemless by design). */
  preJobInspection: boolean;
  /** Code-defined (JobSheetDraft) — always true once the table exists. */
  jobSheet: boolean;
}

/**
 * CR-2026-106 — the exact predicate the API applies when a form is opened
 * (`inspections.service.ts` create): per kind, the highest-version ACTIVE template,
 * and for the vehicle inspection that row must carry items. Seed, deploy-check and
 * /health all call this so "seeded" can never disagree with "works".
 */
export async function requiredFormsState(prisma: PrismaClient): Promise<RequiredFormsState> {
  const [vi, pre] = await Promise.all([
    prisma.inspectionTemplate.findFirst({
      where: { isActive: true, kind: 'VEHICLE_INSPECTION' },
      orderBy: { version: 'desc' },
      select: { id: true, _count: { select: { items: true } } },
    }),
    prisma.inspectionTemplate.findFirst({
      where: { isActive: true, kind: 'PRE_INSPECTION' },
      orderBy: { version: 'desc' },
      select: { id: true },
    }),
  ]);
  let jobSheet = true;
  try {
    await prisma.jobSheetDraft.count();
  } catch {
    jobSheet = false;
  }
  return {
    serviceInspection: !!vi && vi._count.items > 0,
    preJobInspection: !!pre,
    jobSheet,
  };
}

export async function seedInspectionTemplate(prisma: PrismaClient): Promise<{
  templateId: string;
  version: number;
  isActive: boolean;
  itemCount: number;
  categories: number;
  forms: RequiredFormsState;
}> {
  const seeded = await prisma.$transaction(async (tx) => {
    const template = await tx.inspectionTemplate.upsert({
      // Versions are unique per KIND (CR-2026-093): the vehicle checklist and the
      // pre-inspection number their revisions independently.
      where: { kind_version: { kind: 'VEHICLE_INSPECTION', version: TEMPLATE_VERSION } },
      update: { name: TEMPLATE_NAME, isActive: true },
      create: { version: TEMPLATE_VERSION, name: TEMPLATE_NAME, isActive: true, kind: 'VEHICLE_INSPECTION' },
    });

    // The photo-first pre-inspection template. Deliberately itemless: its substance
    // is photographs and condition notes, not a checklist.
    await tx.inspectionTemplate.upsert({
      where: { kind_version: { kind: 'PRE_INSPECTION', version: 1 } },
      update: { isActive: true },
      create: { version: 1, name: 'Pre-Inspection v1', isActive: true, kind: 'PRE_INSPECTION' },
    });
    await tx.inspectionTemplateItem.deleteMany({ where: { templateId: template.id } });
    let order = 0;
    const data: Array<{ templateId: string; category: string; label: string; orderIndex: number; allowsNa: boolean }> = [];
    for (const group of CATEGORIES) {
      for (const it of group.items) {
        data.push({ templateId: template.id, category: group.category, label: it.label, orderIndex: order++, allowsNa: !!it.allowsNa });
      }
    }
    await tx.inspectionTemplateItem.createMany({ data });

    // CR-2026-106 — an ACTIVE vehicle-inspection template with a higher version
    // and no items would shadow this one at runtime (the API reads the top version
    // only). Never let a seed leave the form unusable: deactivate such rows, loudly.
    const shadowing = await tx.inspectionTemplate.findMany({
      where: { kind: 'VEHICLE_INSPECTION', isActive: true, version: { gt: TEMPLATE_VERSION }, items: { none: {} } },
      select: { id: true, version: true, name: true },
    });
    for (const s of shadowing) {
      await tx.inspectionTemplate.update({ where: { id: s.id }, data: { isActive: false } });
      console.warn(`Inspection template "${s.name}" v${s.version} was ACTIVE with no items and would have shadowed v${TEMPLATE_VERSION} — deactivated.`);
    }

    return { templateId: template.id, version: template.version, isActive: template.isActive, itemCount: data.length, categories: CATEGORIES.length };
  });

  // Verify with the runtime predicate, not the rows we just wrote.
  const forms = await requiredFormsState(prisma);
  if (!forms.serviceInspection || !forms.preJobInspection) {
    throw new Error(
      `Required inspection forms are NOT usable after seeding — service inspection: ${forms.serviceInspection}, pre-job inspection: ${forms.preJobInspection}. Refusing to report a successful seed.`,
    );
  }
  return { ...seeded, forms };
}
