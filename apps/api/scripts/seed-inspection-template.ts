/**
 * CR-2026-034 (C-1) — seed the v1 active Visual Inspection Form template.
 *
 * Source of truth: docs/56_Visual_Inspection_Form.md (the 3-state checklist lines).
 * Idempotent: upserts InspectionTemplate version 1 (active) and replaces its items
 * (template items are not FK-referenced by inspections — inspections SNAPSHOT lines
 * into InspectionItem — so clear+recreate is safe and re-runnable).
 *
 * Battery extras / brake-tire measurements / flags / prior-damage / comments are
 * structured fields on the inspection, NOT checklist template items, so they are
 * intentionally not seeded here. Typographic hyphens in docs/56 are normalised to
 * ASCII '-'; content matches the spec.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const TEMPLATE_VERSION = 1;
const TEMPLATE_NAME = 'Visual Inspection Form v1';

const CATEGORIES: Array<{ category: string; items: Array<{ label: string; allowsNa?: boolean }> }> = [
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

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const template = await tx.inspectionTemplate.upsert({
        where: { version: TEMPLATE_VERSION },
        update: { name: TEMPLATE_NAME, isActive: true },
        create: { version: TEMPLATE_VERSION, name: TEMPLATE_NAME, isActive: true },
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
      return { templateId: template.id, version: template.version, isActive: template.isActive, itemCount: data.length, categories: CATEGORIES.length };
    });
    console.log('SEED_OK ' + JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('SEED_ERR', e?.message ?? e);
  process.exit(1);
});
